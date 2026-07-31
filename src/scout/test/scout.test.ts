import { afterEach, describe, expect, it, vi } from 'vitest'
import type Anthropic from '@anthropic-ai/sdk'
import { BudgetExceededError } from '../../jobs/costs.js'
import { BrainrotError, classify } from '../../errors.js'
import { DEFAULT_SCOUT } from '../../config/channel.js'
import type { ChannelConfig, ScoutConfig } from '../../config/channel.js'
import { testChannel } from '../../testing/channel.js'
import type { FetchLike } from '../sources/types.js'
import { listTopics, redditCandidates } from '../topics.js'
import { LINK_POST_CONTENT } from '../../stories/_stories.fixtures.js'
import {
  AllChannelsScoringFailedError,
  AllSourcesFailedError,
  SCOUT_RECHECK_MS,
  ScoutRunFailedError,
  scoutAll,
  scoutChannel,
} from '../scout.js'
import type { ScoutChannelResult } from '../scout.js'
import { lastScoutAttemptAt } from '../scout-state.js'
import { SCOUT_SCORE_CHUNK_SIZE } from '../score.js'
import { memDb, seedScoutState, seedTopic } from '../../testing/db.js'

// Channel with scout sources; testChannel supplies every non-scout field.
function scoutedChannel(overrides: Partial<ScoutConfig> = {}, name = 'chan-a'): ChannelConfig {
  return testChannel({ name, scout: { ...DEFAULT_SCOUT, subreddits: ['space'], ...overrides } })
}

// Reddit .rss fixture: the public Atom feed redditSource reads keylessly.
// <entry><id> is the t3_ fullname, exactly as reddit serves it. `target` adds
// the entity-encoded `[link]` anchor reddit uses to name the submission
// target — omit it and the candidate classifies 'link' (the fail-open path).
// `body` adds a self-post SC_OFF/SC_ON span (see below); `content` embeds a
// caller-supplied wire-shaped string verbatim (e.g. a `_stories.fixtures.ts`
// constant, CDATA-wrapped) when neither derived shape fits.
function redditFeed(
  posts: {
    name: string
    title: string
    target?: string
    author?: string
    body?: string
    content?: string
  }[],
): string {
  const entries = posts
    .map((p) => {
      const contentInner = ((): string | undefined => {
        if (p.content !== undefined) return p.content
        if (p.body !== undefined) {
          // The real wire shape: reddit entity-escapes the SC_OFF/SC_ON span's
          // HTML inside <content>, so this exercises fast-xml-parser's decode
          // step exactly like a live self post does, rather than bypassing it
          // with CDATA.
          const raw = `<!-- SC_OFF --><div class="md"><p>${p.body}</p></div><!-- SC_ON -->`
          return raw.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        }
        if (p.target !== undefined) {
          return `&lt;a href=&quot;${p.target}&quot;&gt;[link]&lt;/a&gt;`
        }
        return undefined
      })()
      return `<entry>
        <author><name>${p.author ?? '/u/someone'}</name></author>
        <id>${p.name}</id>
        <link href="https://www.reddit.com/r/space/comments/${p.name}/" />
        <title>${p.title}</title>
        ${contentInner === undefined ? '' : `<content type="html">${contentInner}</content>`}
      </entry>`
    })
    .join('\n')
  return `<?xml version="1.0" encoding="UTF-8"?>
    <feed xmlns="http://www.w3.org/2005/Atom">
      <id>/r/space/.rss</id>
      <title>/r/space</title>
      ${entries}
    </feed>`
}

// URL-substring-keyed fetch stub: string body → 200 response, Error → throw.
// Unmatched URLs throw, so a test never silently hits an unexpected source.
function fetchStub(bodyBySubstring: Record<string, string | Error>): FetchLike {
  return async (input: RequestInfo | URL) => {
    const url = input instanceof Request ? input.url : String(input)
    for (const [needle, body] of Object.entries(bodyBySubstring)) {
      if (url.includes(needle)) {
        if (body instanceof Error) throw body
        return new Response(body, { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
    }
    throw new Error(`unexpected fetch: ${url}`)
  }
}

function fakeClient(response: unknown): { client: Anthropic; create: ReturnType<typeof vi.fn> } {
  const create = vi.fn().mockResolvedValue(response)
  return { client: { messages: { create } } as unknown as Anthropic, create }
}

// A schema-valid emit tool_use carrying the given scores. Default usage costs
// 1000×1 + 200×5 = 2000 usd-micros at the claude-haiku-4-5 list price.
function emitScores(
  scores: { candidateIndex: number; score: number; topic: string; reason: string }[],
  usage = { input_tokens: 1000, output_tokens: 200 },
) {
  return { content: [{ type: 'tool_use', name: 'emit', id: 't1', input: { scores } }], usage }
}

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('scoutChannel', () => {
  it('fetches, scores, inserts, and ledgers under the scout sentinel', async () => {
    const db = memDb()
    const channel = scoutedChannel() // gate is SCOUT_MIN_SCORE (80), not per-channel
    const fetchImpl = fetchStub({
      '/r/space/.rss': redditFeed([
        { name: 't3_aaa', title: 'Moon drifting measured' },
        { name: 't3_bbb', title: 'Buy my telescope (ad)' },
      ]),
    })
    const { client, create } = fakeClient(
      emitScores([
        {
          candidateIndex: 0,
          score: 85,
          topic: 'The Moon is escaping Earth',
          reason: 'novel physics hook',
        },
        { candidateIndex: 1, score: 10, topic: 'Telescope ad', reason: 'commercial spam' },
      ]),
    )
    const result = await scoutChannel(db, channel, { client, fetchImpl })
    expect(result).toEqual({
      channel: 'chan-a',
      fetched: 2,
      droppedMedia: 0,
      droppedAutomated: 0,
      droppedBodyless: 0,
      alreadyKnown: 0,
      scored: 2,
      queued: 1,
      rejected: 1,
      sourceErrors: [],
      costUsdMicros: 2_000,
    })
    const topics = listTopics(db, { channel: 'chan-a' })
    expect(topics).toHaveLength(2)
    const queued = topics.find((t) => t.status === 'candidate')
    // the reframed topic becomes the title; the raw headline is provenance
    expect(queued?.title).toBe('The Moon is escaping Earth')
    expect(queued?.rawTitle).toBe('Moon drifting measured')
    expect(queued?.source).toBe('reddit:r/space')
    const costs = db.prepare('SELECT job_id, provider, operation, usd_micros FROM costs').all()
    expect(costs).toEqual([
      {
        job_id: 'scout:chan-a',
        provider: 'anthropic',
        operation: 'scout-score',
        usd_micros: 2_000,
      },
    ])
    // ONE batched call for the whole channel
    expect(create).toHaveBeenCalledTimes(1)
    db.close()
  })

  it('scores a fetch spanning multiple score chunks, summing cost and queuing every candidate', async () => {
    const db = memDb()
    const channel = scoutedChannel()
    const total = SCOUT_SCORE_CHUNK_SIZE + 5 // forces 2 chunks: 20 + 5
    const posts = Array.from({ length: total }, (_, i) => ({
      name: `t3_${i}`,
      title: `Story ${i}`,
    }))
    const fetchImpl = fetchStub({ '/r/space/.rss': redditFeed(posts) })
    const create = vi.fn()
    for (let offset = 0; offset < total; offset += SCOUT_SCORE_CHUNK_SIZE) {
      const chunkLen = Math.min(SCOUT_SCORE_CHUNK_SIZE, total - offset)
      const scores = Array.from({ length: chunkLen }, (_, i) => ({
        candidateIndex: offset + i,
        score: 85,
        topic: `Topic ${offset + i}`,
        reason: 'ok',
      }))
      create.mockResolvedValueOnce(emitScores(scores, { input_tokens: 100, output_tokens: 50 }))
    }
    const client = { messages: { create } } as unknown as Anthropic

    const result = await scoutChannel(db, channel, { client, fetchImpl })

    expect(create).toHaveBeenCalledTimes(2)
    expect(result.fetched).toBe(total)
    expect(result.scored).toBe(total)
    expect(result.queued).toBe(total)
    // 100×1 + 50×5 = 350 usd-micros per chunk, two chunks
    expect(result.costUsdMicros).toBe(350 * 2)
    expect(listTopics(db, { channel: 'chan-a' })).toHaveLength(total)
    db.close()
  })

  it('stores a topic at SCOUT_MIN_SCORE and rejects one just under it', async () => {
    const db = memDb()
    const channel = scoutedChannel() // gate is the SCOUT_MIN_SCORE constant, not channel config
    const fetchImpl = fetchStub({
      '/r/space/.rss': redditFeed([
        { name: 't3_aaa', title: 'Exactly at the gate' },
        { name: 't3_bbb', title: 'Just under the gate' },
      ]),
    })
    const { client } = fakeClient(
      emitScores([
        { candidateIndex: 0, score: 80, topic: 'At the gate', reason: 'borderline pass' },
        { candidateIndex: 1, score: 79, topic: 'Under the gate', reason: 'borderline fail' },
      ]),
    )
    const result = await scoutChannel(db, channel, { client, fetchImpl })
    expect(result.queued).toBe(1)
    expect(result.rejected).toBe(1)
    const topics = listTopics(db, { channel: 'chan-a' })
    const at = topics.find((t) => t.title === 'At the gate')
    const under = topics.find((t) => t.title === 'Under the gate')
    expect(at?.status).toBe('candidate')
    expect(under?.status).toBe('rejected')
    db.close()
  })

  it('drops image candidates before scoring and counts them', async () => {
    const db = memDb()
    const channel = scoutedChannel()
    const fetchImpl = fetchStub({
      '/r/space/.rss': redditFeed([
        {
          name: 't3_img',
          title: 'Milky way over Yosemite',
          target: 'https://i.redd.it/u0g9ashc6mfh1.jpeg',
        },
        {
          name: 't3_art',
          title: 'Jodrell Bank facing closure',
          target: 'https://www.theguardian.com/science/x',
        },
      ]),
    })
    const { client, create } = fakeClient(
      emitScores([{ candidateIndex: 0, score: 75, topic: 'Jodrell Bank', reason: 'real news' }]),
    )

    const result = await scoutChannel(db, channel, { client, fetchImpl })

    expect(result.fetched).toBe(2)
    expect(result.droppedMedia).toBe(1)
    expect(result.scored).toBe(1)
    // The photo never reached Haiku: the single scored candidate is the article.
    const prompt = create.mock.calls[0][0].messages[0].content as string
    expect(prompt).toContain('Jodrell Bank facing closure')
    expect(prompt).not.toContain('Milky way over Yosemite')
    // ...and left no topics row behind, so the table means "what we considered".
    expect(listTopics(db, { channel: 'chan-a' })).toHaveLength(1)
    db.close()
  })

  it('drops automated recurring threads before scoring and counts them', async () => {
    const db = memDb()
    const channel = scoutedChannel()
    const fetchImpl = fetchStub({
      '/r/space/.rss': redditFeed([
        {
          name: 't3_auto',
          title: 'All Space Questions thread for week of July 26, 2026',
          author: '/u/AutoModerator',
          target: 'https://www.reddit.com/r/space/comments/t3_auto/x/',
        },
        {
          name: 't3_real',
          title: 'Jodrell Bank facing closure',
          target: 'https://www.theguardian.com/science/x',
        },
      ]),
    })
    const { client, create } = fakeClient(
      emitScores([{ candidateIndex: 0, score: 75, topic: 'Jodrell Bank', reason: 'real news' }]),
    )

    const result = await scoutChannel(db, channel, { client, fetchImpl })

    expect(result.droppedAutomated).toBe(1)
    expect(result.scored).toBe(1)
    // Every week's thread is a fresh t3_ id, so dedupe never catches it — the
    // only way it stops costing a scoring slot is to never reach the scorer.
    const prompt = create.mock.calls[0][0].messages[0].content as string
    expect(prompt).not.toContain('All Space Questions thread')
    expect(listTopics(db, { channel: 'chan-a' })).toHaveLength(1)
    db.close()
  })

  it('keeps a human-authored post that merely mentions a thread', async () => {
    const db = memDb()
    const channel = scoutedChannel()
    const fetchImpl = fetchStub({
      '/r/space/.rss': redditFeed([
        {
          name: 't3_human',
          title: 'What will the orbit of starship look like',
          author: '/u/curious_person',
          target: 'https://www.reddit.com/r/space/comments/t3_human/x/',
        },
      ]),
    })
    const { client } = fakeClient(
      emitScores([{ candidateIndex: 0, score: 70, topic: 'Starship orbit', reason: 'good q' }]),
    )

    const result = await scoutChannel(db, channel, { client, fetchImpl })

    expect(result.droppedAutomated).toBe(0)
    expect(result.scored).toBe(1)
    db.close()
  })

  it('re-runs are free: known hashes are filtered before the Haiku call', async () => {
    const db = memDb()
    const channel = scoutedChannel()
    const fetchImpl = fetchStub({
      '/r/space/.rss': redditFeed([{ name: 't3_aaa', title: 'Moon drifting' }]),
    })
    const { client, create } = fakeClient(
      emitScores([{ candidateIndex: 0, score: 20, topic: 'Moon', reason: 'dull' }]),
    )
    // force: true bypasses the recheck gate — this test is about dedup
    // across repeat runs, not the recheck cadence itself (scout.test.ts's
    // recheck-gate cases cover that).
    await scoutChannel(db, channel, { client, fetchImpl, force: true })
    const second = await scoutChannel(db, channel, { client, fetchImpl, force: true })
    expect(second).toEqual({
      channel: 'chan-a',
      fetched: 1,
      droppedMedia: 0,
      droppedAutomated: 0,
      droppedBodyless: 0,
      alreadyKnown: 1,
      scored: 0,
      queued: 0,
      rejected: 0,
      sourceErrors: [],
      costUsdMicros: 0,
    })
    // the second run never reached Haiku
    expect(create).toHaveBeenCalledTimes(1)
    // the below-threshold row stayed a remembered rejection — never re-scored
    expect(listTopics(db, { channel: 'chan-a', status: 'rejected' })).toHaveLength(1)
    db.close()
  })

  it('isolates a failing source: one sourceErrors entry, other sources still scout', async () => {
    const db = memDb()
    const channel = scoutedChannel({ subreddits: ['space', 'askscience'] })
    const fetchImpl = fetchStub({
      '/r/space/.rss': new Error('connect timeout'),
      '/r/askscience/.rss': redditFeed([{ name: 't3_ccc', title: 'Why is the sky blue' }]),
    })
    const { client } = fakeClient(
      emitScores([
        { candidateIndex: 0, score: 80, topic: 'Sky color explained', reason: 'classic' },
      ]),
    )
    const result = await scoutChannel(db, channel, { client, fetchImpl })
    expect(result.fetched).toBe(1)
    expect(result.queued).toBe(1)
    expect(result.sourceErrors).toHaveLength(1)
    // entries are prefixed with the failing source's id
    expect(result.sourceErrors[0]).toMatch(/^reddit:r\/space: /)
    db.close()
  })

  it('isolates a source whose constructor throws on a malformed rss URL', async () => {
    const db = memDb()
    // rssSource runs `new URL(url)` at construction; a malformed feed URL must
    // fault only that source, not abort the whole channel before isolation.
    const channel = scoutedChannel({ subreddits: ['space'], rss: ['not a url'] })
    const fetchImpl = fetchStub({
      '/r/space/.rss': redditFeed([{ name: 't3_ok', title: 'Why is the sky blue' }]),
    })
    const { client } = fakeClient(
      emitScores([
        { candidateIndex: 0, score: 80, topic: 'Sky color explained', reason: 'classic' },
      ]),
    )
    const result = await scoutChannel(db, channel, { client, fetchImpl })
    // the good subreddit still scouted and queued despite the bad feed URL
    expect(result.fetched).toBe(1)
    expect(result.queued).toBe(1)
    // exactly one error, prefixed with the RAW url (no hostname to derive an id)
    expect(result.sourceErrors).toHaveLength(1)
    expect(result.sourceErrors[0]).toMatch(/^rss:not a url: /)
    db.close()
  })

  it('gates on the global day budget BEFORE spending', async () => {
    vi.stubEnv('BRAINROT_GLOBAL_DAILY_USD', '0')
    const db = memDb()
    const channel = scoutedChannel()
    const fetchImpl = fetchStub({
      '/r/space/.rss': redditFeed([{ name: 't3_aaa', title: 'Moon drifting' }]),
    })
    const { client, create } = fakeClient(emitScores([]))
    await expect(scoutChannel(db, channel, { client, fetchImpl })).rejects.toThrow(
      BudgetExceededError,
    )
    // gate fired pre-call: no API hit, no cost row, no topics
    expect(create).not.toHaveBeenCalled()
    expect(db.prepare('SELECT COUNT(*) AS n FROM costs').get()).toEqual({ n: 0 })
    expect(listTopics(db)).toHaveLength(0)
    db.close()
  })

  it('ledgers spend from a paid-but-invalid scoring response, then rethrows', async () => {
    const db = memDb()
    const channel = scoutedChannel()
    const fetchImpl = fetchStub({
      '/r/space/.rss': redditFeed([{ name: 't3_aaa', title: 'Moon drifting' }]),
    })
    // schema-invalid emit input: structuredCompletion throws a ZodError with
    // costUsdMicros attached (the call was billed regardless)
    const { client } = fakeClient({
      content: [{ type: 'tool_use', name: 'emit', id: 't1', input: { scores: 'not-an-array' } }],
      usage: { input_tokens: 100, output_tokens: 50 },
    })
    await expect(scoutChannel(db, channel, { client, fetchImpl })).rejects.toThrow()
    const costs = db.prepare('SELECT job_id, operation, usd_micros FROM costs').all()
    // 100×1 + 50×5 = 350 usd-micros at the haiku list price
    expect(costs).toEqual([{ job_id: 'scout:chan-a', operation: 'scout-score', usd_micros: 350 }])
    expect(listTopics(db)).toHaveLength(0)
    db.close()
  })

  it('rolls the ledger row back when the topic insert fails (one transaction)', async () => {
    const db = memDb()
    const channel = scoutedChannel()
    const fetchImpl = fetchStub({
      '/r/space/.rss': redditFeed([{ name: 't3_aaa', title: 'Moon drifting' }]),
    })
    const { client } = fakeClient(
      emitScores([{ candidateIndex: 0, score: 70, topic: 'Moon escape', reason: 'ok' }]),
    )
    // Fail the batch insert the way a disk-full or locked db would, AFTER the
    // scoring call was billed. A surviving cost row with no dedupe hashes means
    // the next run re-pays Haiku for the very same items.
    db.exec(
      "CREATE TRIGGER fail_topic_insert BEFORE INSERT ON topics BEGIN SELECT RAISE(ABORT, 'insert blocked'); END",
    )
    await expect(scoutChannel(db, channel, { client, fetchImpl })).rejects.toThrow(/insert blocked/)
    expect(db.prepare('SELECT COUNT(*) AS n FROM costs').get()).toEqual({ n: 0 })
    expect(listTopics(db)).toHaveLength(0)
    db.close()
  })

  it('skips a channel whose candidate queue is already deep enough', async () => {
    const db = memDb()
    const fetchImpl = vi.fn()
    const channel = testChannel({
      name: 'chan-a',
      videosPerDay: 2,
      scout: {
        subreddits: ['space'],
        rss: [],
        perSourceLimit: 25,
        queueDays: 3,
        generateTopics: 0,
      },
    })
    for (let i = 0; i < 6; i++) {
      seedTopic(db, { channel: 'chan-a', status: 'candidate', dedupeHash: `hash-${String(i)}` })
    }

    const result = await scoutChannel(db, channel, { fetchImpl })

    expect(result.skipped).toBe('queue-full')
    expect(result.fetched).toBe(0)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('scouts when the queue is one short of the cap', async () => {
    const db = memDb()
    const channel = testChannel({
      name: 'chan-a',
      videosPerDay: 2,
      scout: {
        subreddits: ['space'],
        rss: [],
        perSourceLimit: 25,
        queueDays: 3,
        generateTopics: 0,
      },
    })
    for (let i = 0; i < 5; i++) {
      seedTopic(db, { channel: 'chan-a', status: 'candidate', dedupeHash: `hash-${String(i)}` })
    }
    const fetchImpl = vi.fn(() => Promise.reject(new Error('source down')))

    const result = await scoutChannel(db, channel, { fetchImpl })

    expect(result.skipped).toBeUndefined()
    expect(fetchImpl).toHaveBeenCalled()
  })

  it('does not count rejected or used topics toward the queue', async () => {
    const db = memDb()
    const channel = testChannel({
      name: 'chan-a',
      videosPerDay: 2,
      scout: {
        subreddits: ['space'],
        rss: [],
        perSourceLimit: 25,
        queueDays: 3,
        generateTopics: 0,
      },
    })
    for (let i = 0; i < 10; i++) {
      seedTopic(db, { channel: 'chan-a', status: 'rejected', dedupeHash: `r-${String(i)}` })
    }
    const fetchImpl = vi.fn(() => Promise.reject(new Error('source down')))

    const result = await scoutChannel(db, channel, { fetchImpl })

    expect(result.skipped).toBeUndefined()
    expect(fetchImpl).toHaveBeenCalled()
  })

  it('skips a channel scouted within SCOUT_RECHECK_MS, without touching sources', async () => {
    const db = memDb()
    const fetchImpl = vi.fn()
    const channel = scoutedChannel()
    const now = new Date(2026, 6, 28, 12, 0, 0)
    seedScoutState(db, 'chan-a', new Date(now.getTime() - 5 * 60_000))

    const result = await scoutChannel(db, channel, { fetchImpl, now })

    expect(result.skipped).toBe('recheck-not-due')
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('scouts again once SCOUT_RECHECK_MS has elapsed since the last attempt', async () => {
    const db = memDb()
    const channel = scoutedChannel()
    const now = new Date(2026, 6, 28, 12, 0, 0)
    seedScoutState(db, 'chan-a', new Date(now.getTime() - SCOUT_RECHECK_MS))
    const fetchImpl = vi.fn(() => Promise.reject(new Error('source down')))

    const result = await scoutChannel(db, channel, { fetchImpl, now })

    expect(result.skipped).toBeUndefined()
    expect(fetchImpl).toHaveBeenCalled()
  })

  it('records the attempt even when the channel is queue-full', async () => {
    const db = memDb()
    const channel = testChannel({
      name: 'chan-a',
      videosPerDay: 2,
      scout: {
        subreddits: ['space'],
        rss: [],
        perSourceLimit: 25,
        queueDays: 3,
        generateTopics: 0,
      },
    })
    for (let i = 0; i < 6; i++) {
      seedTopic(db, { channel: 'chan-a', status: 'candidate', dedupeHash: `hash-${String(i)}` })
    }
    const now = new Date(2026, 6, 28, 12, 0, 0)

    const result = await scoutChannel(db, channel, { fetchImpl: vi.fn(), now })

    expect(result.skipped).toBe('queue-full')
    expect(lastScoutAttemptAt(db, 'chan-a')).toEqual(now)
  })

  it('records the attempt even when scoring later throws', async () => {
    vi.stubEnv('BRAINROT_GLOBAL_DAILY_USD', '0')
    const db = memDb()
    const channel = scoutedChannel()
    const now = new Date(2026, 6, 28, 12, 0, 0)
    const fetchImpl = fetchStub({
      '/r/space/.rss': redditFeed([{ name: 't3_aaa', title: 'Moon drifting' }]),
    })
    const { client } = fakeClient(emitScores([]))

    await expect(scoutChannel(db, channel, { client, fetchImpl, now })).rejects.toThrow(
      BudgetExceededError,
    )
    expect(lastScoutAttemptAt(db, 'chan-a')).toEqual(now)
  })

  it('force bypasses the recheck gate regardless of the last attempt', async () => {
    const db = memDb()
    const channel = scoutedChannel()
    const now = new Date(2026, 6, 28, 12, 0, 0)
    seedScoutState(db, 'chan-a', new Date(now.getTime() - 1))
    const fetchImpl = vi.fn(() => Promise.reject(new Error('source down')))

    const result = await scoutChannel(db, channel, { fetchImpl, now, force: true })

    expect(result.skipped).toBeUndefined()
    expect(fetchImpl).toHaveBeenCalled()
  })
})

describe('scoutAll', () => {
  it('skips sourceless channels and isolates a scoring failure per channel', async () => {
    const db = memDb()
    const stderrSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const manualOnly = testChannel({ name: 'manual-only' }) // DEFAULT_SCOUT: no sources
    const bad = scoutedChannel({ subreddits: ['failing'] }, 'bad')
    const good = scoutedChannel({}, 'good')
    const fetchImpl = fetchStub({
      '/r/failing/.rss': redditFeed([{ name: 't3_f', title: 'F' }]),
      '/r/space/.rss': redditFeed([{ name: 't3_g', title: 'G' }]),
    })
    // first scoring call (bad) is paid-but-invalid; second (good) is valid
    const create = vi
      .fn()
      .mockResolvedValueOnce({
        content: [{ type: 'tool_use', name: 'emit', id: 't1', input: { scores: 'nope' } }],
        usage: { input_tokens: 10, output_tokens: 5 },
      })
      .mockResolvedValueOnce(
        emitScores([{ candidateIndex: 0, score: 90, topic: 'Good topic', reason: 'strong' }]),
      )
    const client = { messages: { create } } as unknown as Anthropic

    const results = await scoutAll(db, [manualOnly, bad, good], { client, fetchImpl })
    expect(results.map((r) => r.channel)).toEqual(['bad', 'good']) // manual-only skipped
    expect(results[0].scoringError).toBeDefined()
    expect(results[0].queued).toBe(0)
    expect(results[0].fetched).toBe(1) // fetch counts survive the scoring failure
    expect(results[1].scoringError).toBeUndefined()
    expect(results[1].queued).toBe(1)
    // the failing channel logged to stderr and its paid spend was ledgered
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('bad'))
    const costs = db.prepare('SELECT job_id FROM costs ORDER BY id').all()
    expect(costs).toEqual([{ job_id: 'scout:bad' }, { job_id: 'scout:good' }])
    stderrSpy.mockRestore()
    db.close()
  })

  it('throws AllSourcesFailedError only when every source everywhere failed', async () => {
    const db = memDb()
    const a = scoutedChannel({ subreddits: ['one'] }, 'a')
    const b = scoutedChannel({ subreddits: ['two'] }, 'b')
    // fetchStub({}) rejects every URL — total source failure
    const { client, create } = fakeClient(emitScores([]))
    const err = await scoutAll(db, [a, b], { client, fetchImpl: fetchStub({}), force: true }).then(
      () => null,
      (e: unknown) => e,
    )
    expect(err).toBeInstanceOf(AllSourcesFailedError)
    // the error carries every channel's result so the CLI still prints its JSON line
    expect((err as AllSourcesFailedError).results.map((r) => r.channel)).toEqual(['a', 'b'])
    expect(create).not.toHaveBeenCalled()

    // one healthy source flips it back to a normal (partial) run. force: true
    // again — this test is about the all-sources-failed transition, not the
    // recheck cadence (covered separately in scoutChannel's own tests).
    const mixed = fetchStub({ '/r/two/.rss': redditFeed([{ name: 't3_x', title: 'X' }]) })
    const { client: client2 } = fakeClient(
      emitScores([{ candidateIndex: 0, score: 80, topic: 'X topic', reason: 'ok' }]),
    )
    const results = await scoutAll(db, [a, b], { client: client2, fetchImpl: mixed, force: true })
    expect(results).toHaveLength(2)
    expect(results[0].sourceErrors).toHaveLength(1)
    expect(results[1].queued).toBe(1)
    db.close()
  })

  it('throws AllChannelsScoringFailedError when sources are fine but every channel failed scoring', async () => {
    const db = memDb()
    const stderrSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const a = scoutedChannel({ subreddits: ['one'] }, 'a')
    const b = scoutedChannel({ subreddits: ['two'] }, 'b')
    const fetchImpl = fetchStub({
      '/r/one/.rss': redditFeed([{ name: 't3_a', title: 'A' }]),
      '/r/two/.rss': redditFeed([{ name: 't3_b', title: 'B' }]),
    })
    // Every scoring call is paid-but-invalid (the shape an expired key or a
    // provider outage produces): sourceErrors stays empty, so nothing else
    // would flag this run as anything but healthy.
    const { client } = fakeClient({
      content: [{ type: 'tool_use', name: 'emit', id: 't1', input: { scores: 'nope' } }],
      usage: { input_tokens: 10, output_tokens: 5 },
    })
    const err = await scoutAll(db, [a, b], { client, fetchImpl }).then(
      () => null,
      (e: unknown) => e,
    )
    expect(err).toBeInstanceOf(AllChannelsScoringFailedError)
    // the error carries every channel's result so the CLI still prints its JSON line
    expect((err as AllChannelsScoringFailedError).results.map((r) => r.channel)).toEqual(['a', 'b'])
    expect(
      (err as AllChannelsScoringFailedError).results.every((r) => r.scoringError !== undefined),
    ).toBe(true)
    stderrSpy.mockRestore()
    db.close()
  })

  // The global day cap is GLOBAL, so once it is reached every channel fails
  // the same gate — and the cap working is not a failed run. Treating it as
  // one meant every scout firing exited 1 for the rest of the UTC day.
  it('stays healthy when every channel is blocked by the global day budget', async () => {
    vi.stubEnv('BRAINROT_GLOBAL_DAILY_USD', '0')
    const db = memDb()
    const stderrSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const a = scoutedChannel({ subreddits: ['one'] }, 'a')
    const b = scoutedChannel({ subreddits: ['two'] }, 'b')
    const fetchImpl = fetchStub({
      '/r/one/.rss': redditFeed([{ name: 't3_a', title: 'A' }]),
      '/r/two/.rss': redditFeed([{ name: 't3_b', title: 'B' }]),
    })
    const { client } = fakeClient(emitScores([]))
    const results = await scoutAll(db, [a, b], { client, fetchImpl })
    // Still reported per channel — the operator sees why nothing was scored.
    expect(results.map((r) => r.channel)).toEqual(['a', 'b'])
    expect(results.every((r) => r.scoringError?.includes('global-day'))).toBe(true)
    // Regression guard: the budget gate fires INSIDE scoreWithLedger, after
    // fetch/dedupe already ran — so each channel made real progress (fetched
    // one candidate, queued it for scoring) before being blocked. That
    // progress rides to scoutAll as a `partial` ScoutChannelResult tagged
    // onto the (already-classified) BudgetExceededError. classify() used to
    // discard a tag entirely once the thrown value was already a
    // BrainrotError, which silently zeroed these counts back to the
    // no-progress fallback — exactly the data the scout CLI's stdout JSON
    // line reports to cron.
    expect(results.every((r) => r.fetched === 1)).toBe(true)
    expect(results.every((r) => r.scored === 1)).toBe(true)
    expect(results.every((r) => r.alreadyKnown === 0)).toBe(true)
    stderrSpy.mockRestore()
    db.close()
  })

  // The mixed case still fails: one channel out of budget does not excuse the
  // other dying on an expired key.
  it('still throws when a real scoring failure sits alongside a budget-blocked channel', async () => {
    const db = memDb()
    const stderrSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const a = scoutedChannel({ subreddits: ['one'] }, 'a')
    const b = scoutedChannel({ subreddits: ['two'] }, 'b')
    const fetchImpl = fetchStub({
      '/r/one/.rss': redditFeed([{ name: 't3_a', title: 'A' }]),
      '/r/two/.rss': redditFeed([{ name: 't3_b', title: 'B' }]),
    })
    // Cap set to exactly one scout reservation ($0.02): channel "a" clears the
    // gate and then dies on a paid-but-invalid response, whose ledgered spend
    // leaves "b" short of a reservation and blocked on the global-day budget.
    vi.stubEnv('BRAINROT_GLOBAL_DAILY_USD', '0.02')
    const { client } = fakeClient({
      content: [{ type: 'tool_use', name: 'emit', id: 't1', input: { scores: 'nope' } }],
      usage: { input_tokens: 10, output_tokens: 5 },
    })
    const err = await scoutAll(db, [a, b], { client, fetchImpl }).then(
      () => null,
      (e: unknown) => e,
    )
    expect(err).toBeInstanceOf(AllChannelsScoringFailedError)
    const failed = err as AllChannelsScoringFailedError
    expect(failed.results.map((r) => r.channel)).toEqual(['a', 'b'])
    // "a" died on the response, "b" never got to spend — and the message
    // counts only the channel that hit a real error.
    expect(failed.results[0].scoringError).not.toContain('global-day')
    expect(failed.results[1].scoringError).toContain('global-day')
    // "b" still fetched and queued its one candidate for scoring before the
    // global-day gate blocked it — that real progress must survive onto the
    // result, not read back as zeros.
    expect(failed.results[1].fetched).toBe(1)
    expect(failed.results[1].scored).toBe(1)
    expect(failed.message).toBe(
      'all 1 scouted channel(s) failed in scoring (1 more budget-blocked)',
    )
    stderrSpy.mockRestore()
    db.close()
  })

  it('stays healthy when a run genuinely finds nothing new (every item already known)', async () => {
    const db = memDb()
    const a = scoutedChannel({ subreddits: ['one'] }, 'a')
    const fetchImpl = fetchStub({
      '/r/one/.rss': redditFeed([{ name: 't3_a', title: 'A' }]),
    })
    const { client, create } = fakeClient(
      emitScores([{ candidateIndex: 0, score: 70, topic: 'A topic', reason: 'ok' }]),
    )
    await scoutAll(db, [a], { client, fetchImpl, force: true })
    // second pass: the hash filter empties the batch before scoring — zero
    // topics, zero spend, and NOT a failure. force: true bypasses the recheck
    // gate, which isn't what this test is about.
    const results = await scoutAll(db, [a], { client, fetchImpl, force: true })
    expect(results).toEqual([
      {
        channel: 'a',
        fetched: 1,
        droppedMedia: 0,
        droppedAutomated: 0,
        droppedBodyless: 0,
        alreadyKnown: 1,
        scored: 0,
        queued: 0,
        rejected: 0,
        sourceErrors: [],
        costUsdMicros: 0,
      },
    ])
    expect(create).toHaveBeenCalledTimes(1)
    db.close()
  })

  it('does not count a skipped channel toward the all-sources-failed test', async () => {
    const db = memDb()
    const full = testChannel({
      name: 'chan-full',
      videosPerDay: 2,
      scout: {
        subreddits: ['space'],
        rss: [],
        perSourceLimit: 25,
        queueDays: 3,
        generateTopics: 0,
      },
    })
    for (let i = 0; i < 6; i++) {
      seedTopic(db, { channel: 'chan-full', status: 'candidate', dedupeHash: `h-${String(i)}` })
    }

    const results = await scoutAll(db, [full], { fetchImpl: vi.fn() })

    expect(results).toHaveLength(1)
    expect(results[0].skipped).toBe('queue-full')
  })

  it('still throws when a real scoring failure sits alongside a queue-full channel', async () => {
    // A skipped channel never reached scoring, so it can carry no
    // scoringError. Left inside the all-channels test, ONE of them made
    // `every` false and swallowed a genuine scoring outage on every other
    // channel — the run exited 0 while the queue quietly drained.
    const db = memDb()
    const stderrSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const full = testChannel({
      name: 'chan-full',
      videosPerDay: 2,
      scout: {
        subreddits: ['space'],
        rss: [],
        perSourceLimit: 25,
        queueDays: 3,
        generateTopics: 0,
      },
    })
    for (let i = 0; i < 6; i++) {
      seedTopic(db, { channel: 'chan-full', status: 'candidate', dedupeHash: `h-${String(i)}` })
    }
    const broken = scoutedChannel({ subreddits: ['two'] }, 'b')
    const fetchImpl = fetchStub({ '/r/two/.rss': redditFeed([{ name: 't3_b', title: 'B' }]) })
    const { client } = fakeClient({
      content: [{ type: 'tool_use', name: 'emit', id: 't1', input: { scores: 'nope' } }],
      usage: { input_tokens: 10, output_tokens: 5 },
    })

    const err = await scoutAll(db, [full, broken], { client, fetchImpl }).then(
      () => null,
      (e: unknown) => e,
    )

    expect(err).toBeInstanceOf(AllChannelsScoringFailedError)
    const failed = err as AllChannelsScoringFailedError
    // The count ranges over the one channel that actually tried to score.
    expect(failed.message).toBe('all 1 scouted channel(s) failed in scoring')
    // Both channels' results still ride out for the CLI's JSON line.
    expect(failed.results.map((r) => r.channel)).toEqual(['chan-full', 'b'])
    stderrSpy.mockRestore()
    db.close()
  })
})

describe('scoutChannel story mode', () => {
  it('drops bodyless candidates before scoring and counts them', async () => {
    const db = memDb()
    const channel = testChannel({
      name: 'aita',
      story: { maxParts: 4 },
      scout: { ...DEFAULT_SCOUT, subreddits: ['AskReddit'] },
    })
    const { client, create } = fakeClient(emitScores([]))
    const fetchImpl = fetchStub({
      '/r/AskReddit/.rss': redditFeed([
        {
          name: 't3_a',
          title: 'What is your worst job story?',
          author: '/u/x',
          content: `<![CDATA[${LINK_POST_CONTENT}]]>`,
        },
        {
          name: 't3_b',
          title: 'What is your best job story?',
          author: '/u/y',
          content: `<![CDATA[${LINK_POST_CONTENT}]]>`,
        },
      ]),
    })

    const result = await scoutChannel(db, channel, { client, fetchImpl })

    expect(result.fetched).toBe(2)
    expect(result.droppedBodyless).toBe(2)
    expect(result.scored).toBe(0)
    expect(create).not.toHaveBeenCalled()
    db.close()
  })

  it('does not drop bodyless candidates on a topic-mode channel', async () => {
    const db = memDb()
    const channel = testChannel({
      name: 'space',
      story: null,
      scout: { ...DEFAULT_SCOUT, subreddits: ['space'] },
    })
    const { client } = fakeClient(
      emitScores([{ candidateIndex: 0, score: 90, topic: 'T', reason: 'R' }]),
    )
    const fetchImpl = fetchStub({
      '/r/space/.rss': redditFeed([
        {
          name: 't3_a',
          title: 'Voyager 1 phones home',
          content: `<![CDATA[${LINK_POST_CONTENT}]]>`,
        },
      ]),
    })

    const result = await scoutChannel(db, channel, { client, fetchImpl })

    expect(result.droppedBodyless).toBe(0)
    expect(result.scored).toBe(1)
    db.close()
  })

  it('inserts one row per part, sharing a score and series key', async () => {
    const db = memDb()
    const channel = testChannel({
      name: 'aita',
      videosPerDay: 3,
      backlogDays: 2,
      story: { maxParts: 4 },
      scout: { ...DEFAULT_SCOUT, subreddits: ['AmItheAsshole'] },
    })
    // 400 words of sentences: at 160 words/part that is three parts.
    const long = Array.from(
      { length: 40 },
      (_, i) => `Sentence ${i} has exactly ten words in it now.`,
    ).join(' ')
    const { client } = fakeClient(
      emitScores([
        { candidateIndex: 0, score: 88, topic: 'She blended the fruit', reason: 'strong conflict' },
      ]),
    )
    const fetchImpl = fetchStub({
      '/r/AmItheAsshole/.rss': redditFeed([
        { name: 't3_abc', title: 'AITA for not apologizing?', author: '/u/real', body: long },
      ]),
    })

    const result = await scoutChannel(db, channel, { client, fetchImpl })

    expect(result.queued).toBe(3)
    // redditCandidates orders by id — insertion order within the fan-out
    // transaction — which exists to serve the prune pass, not this test. The
    // four ordering-sensitive assertions in this describe lean on it; a
    // future change to prune's own ordering must not silently break these
    // for an unrelated reason.
    const rows = redditCandidates(db, 'aita')
    expect(rows).toHaveLength(3)
    expect(rows.map((r) => r.partIndex)).toEqual([1, 2, 3])
    expect(rows.map((r) => r.title)).toEqual([
      'She blended the fruit (1/3)',
      'She blended the fruit (2/3)',
      'She blended the fruit (3/3)',
    ])
    expect(new Set(rows.map((r) => r.seriesKey)).size).toBe(1)
    expect(new Set(rows.map((r) => r.score))).toEqual(new Set([88]))
    expect(new Set(rows.map((r) => r.dedupeHash)).size).toBe(3)
    expect(rows.every((r) => r.rawTitle === 'AITA for not apologizing?')).toBe(true)
    expect(rows.every((r) => r.truncated === false)).toBe(true)
    expect(rows.map((r) => r.bodyText).join(' ')).toBe(long)
    db.close()
  })

  it('marks every part truncated when the story exceeds max_parts', async () => {
    const db = memDb()
    const channel = testChannel({
      name: 'aita',
      videosPerDay: 3,
      backlogDays: 2,
      story: { maxParts: 2 },
      scout: { ...DEFAULT_SCOUT, subreddits: ['AmItheAsshole'] },
    })
    const long = Array.from(
      { length: 60 },
      (_, i) => `Sentence ${i} has exactly ten words in it now.`,
    ).join(' ')
    const { client } = fakeClient(
      emitScores([{ candidateIndex: 0, score: 88, topic: 'A long one', reason: 'strong' }]),
    )
    const fetchImpl = fetchStub({
      '/r/AmItheAsshole/.rss': redditFeed([
        { name: 't3_abc', title: 'AITA?', author: '/u/real', body: long },
      ]),
    })

    await scoutChannel(db, channel, { client, fetchImpl })

    const rows = redditCandidates(db, 'aita')
    expect(rows).toHaveLength(2)
    expect(rows.every((r) => r.truncated === true)).toBe(true)
    db.close()
  })

  it('omits the part suffix from a single-part story but still fills the columns', async () => {
    const db = memDb()
    const channel = testChannel({
      name: 'aita',
      videosPerDay: 3,
      backlogDays: 2,
      story: { maxParts: 4 },
      scout: { ...DEFAULT_SCOUT, subreddits: ['AmItheAsshole'] },
    })
    const short = Array.from(
      { length: 6 },
      (_, i) => `Sentence ${i} has exactly ten words in it now.`,
    ).join(' ')
    const { client } = fakeClient(
      emitScores([{ candidateIndex: 0, score: 88, topic: 'Short one', reason: 'strong' }]),
    )
    const fetchImpl = fetchStub({
      '/r/AmItheAsshole/.rss': redditFeed([
        { name: 't3_s', title: 'AITA?', author: '/u/real', body: short },
      ]),
    })

    await scoutChannel(db, channel, { client, fetchImpl })

    const [row] = redditCandidates(db, 'aita')
    expect(row.title).toBe('Short one')
    expect(row.partIndex).toBe(1)
    expect(row.partCount).toBe(1)
    expect(row.seriesKey).not.toBeNull()
    db.close()
  })

  it('stores a rejected story as a single row with no parts', async () => {
    const db = memDb()
    const channel = testChannel({
      name: 'aita',
      story: { maxParts: 4 },
      scout: { ...DEFAULT_SCOUT, subreddits: ['AmItheAsshole'] },
    })
    const long = Array.from(
      { length: 40 },
      (_, i) => `Sentence ${i} has exactly ten words in it now.`,
    ).join(' ')
    const { client } = fakeClient(
      emitScores([{ candidateIndex: 0, score: 10, topic: 'Weak', reason: 'no conflict' }]),
    )
    const fetchImpl = fetchStub({
      '/r/AmItheAsshole/.rss': redditFeed([
        { name: 't3_w', title: 'AITA?', author: '/u/real', body: long },
      ]),
    })

    const result = await scoutChannel(db, channel, { client, fetchImpl })

    expect(result.queued).toBe(0)
    expect(result.rejected).toBe(1)
    const rows = listTopics(db, { channel: 'aita' })
    expect(rows).toHaveLength(1)
    expect(rows[0].partIndex).toBeNull()
    expect(rows[0].seriesKey).toBeNull()
    db.close()
  })

  it('re-scouting a queued story is free: the base hash is recognized via series_key', async () => {
    const db = memDb()
    const channel = testChannel({
      name: 'aita',
      videosPerDay: 3,
      backlogDays: 2,
      story: { maxParts: 4 },
      scout: { ...DEFAULT_SCOUT, subreddits: ['AmItheAsshole'] },
    })
    // 400 words at 160 words/part: three parts, each stored under its own
    // suffixed dedupe hash with the un-suffixed base hash in series_key.
    const long = Array.from(
      { length: 40 },
      (_, i) => `Sentence ${i} has exactly ten words in it now.`,
    ).join(' ')
    const { client, create } = fakeClient(
      emitScores([
        { candidateIndex: 0, score: 88, topic: 'She blended the fruit', reason: 'strong' },
      ]),
    )
    const fetchImpl = fetchStub({
      '/r/AmItheAsshole/.rss': redditFeed([
        { name: 't3_abc', title: 'AITA for not apologizing?', author: '/u/real', body: long },
      ]),
    })

    // force: true on both calls — this test is about hash recognition across
    // repeat runs, not the recheck cadence (covered separately).
    const first = await scoutChannel(db, channel, { client, fetchImpl, force: true })
    expect(first.queued).toBe(3)
    const second = await scoutChannel(db, channel, { client, fetchImpl, force: true })

    expect(second).toEqual({
      channel: 'aita',
      fetched: 1,
      droppedMedia: 0,
      droppedAutomated: 0,
      droppedBodyless: 0,
      alreadyKnown: 1,
      scored: 0,
      queued: 0,
      rejected: 0,
      sourceErrors: [],
      costUsdMicros: 0,
    })
    // the second run never reached Haiku — the base hash was recognized via
    // series_key even though no row's own dedupe_hash matches it
    expect(create).toHaveBeenCalledTimes(1)
    // no new rows: still exactly the three parts from the first run
    expect(redditCandidates(db, 'aita')).toHaveLength(3)
    db.close()
  })

  it('re-scouting a topic-mode channel still recognizes the known hash (series_key union matches nothing)', async () => {
    const db = memDb()
    const channel = scoutedChannel({}, 'space-topic')
    const fetchImpl = fetchStub({
      '/r/space/.rss': redditFeed([{ name: 't3_aaa', title: 'Moon drifting' }]),
    })
    const { client, create } = fakeClient(
      emitScores([{ candidateIndex: 0, score: 90, topic: 'Moon topic', reason: 'ok' }]),
    )

    const first = await scoutChannel(db, channel, { client, fetchImpl, force: true })
    expect(first.queued).toBe(1)
    const second = await scoutChannel(db, channel, { client, fetchImpl, force: true })

    expect(second.alreadyKnown).toBe(1)
    expect(second.scored).toBe(0)
    expect(second.queued).toBe(0)
    expect(second.costUsdMicros).toBe(0)
    expect(create).toHaveBeenCalledTimes(1)
    expect(listTopics(db, { channel: 'space-topic' })).toHaveLength(1)
    db.close()
  })
})

describe('scout error classification', () => {
  it('classifies the systemic failures as scout/transient, keeping results', () => {
    const results: ScoutChannelResult[] = []
    for (const err of [
      new AllSourcesFailedError('all 3 trend source(s) failed', results),
      new AllChannelsScoringFailedError('all 2 scouted channel(s) failed', results),
    ]) {
      expect(err).toBeInstanceOf(BrainrotError)
      expect(err).toBeInstanceOf(ScoutRunFailedError)
      expect(err.results).toBe(results)
      expect(classify(err)).toMatchObject({ domain: 'scout', kind: 'transient' })
    }
  })
})
