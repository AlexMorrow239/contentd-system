import { afterEach, describe, expect, it, vi } from 'vitest'
import type Anthropic from '@anthropic-ai/sdk'
import { openDb } from '../db/index.js'
import { BudgetExceededError } from '../jobs/costs.js'
import { DEFAULT_SCOUT } from '../config/channel.js'
import type { ChannelConfig, ScoutConfig } from '../config/channel.js'
import { testChannel } from '../stages/_testkit.js'
import type { FetchLike } from './sources/types.js'
import { listTopics } from './topics.js'
import { AllSourcesFailedError, scoutAll, scoutChannel } from './scout.js'

// Channel with scout sources; testChannel supplies every non-scout field.
function scoutedChannel(overrides: Partial<ScoutConfig> = {}, name = 'chan-a'): ChannelConfig {
  return testChannel({ name, scout: { ...DEFAULT_SCOUT, subreddits: ['space'], ...overrides } })
}

// Reddit hot.json fixture: exactly the fields redditSource reads.
function redditJson(posts: { name: string; title: string; stickied?: boolean }[]): string {
  return JSON.stringify({
    data: {
      children: posts.map((p) => ({
        kind: 't3',
        data: {
          name: p.name,
          title: p.title,
          permalink: `/r/space/comments/${p.name}/`,
          stickied: p.stickied ?? false,
        },
      })),
    },
  })
}

// URL-substring-keyed fetch stub: string body → 200 response, Error → throw.
// Unmatched URLs throw, so a test never silently hits an unexpected source.
function fetchStub(bodyBySubstring: Record<string, string | Error>): FetchLike {
  return (async (input: RequestInfo | URL) => {
    const url = String(input)
    for (const [needle, body] of Object.entries(bodyBySubstring)) {
      if (url.includes(needle)) {
        if (body instanceof Error) throw body
        return new Response(body, { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
    }
    throw new Error(`unexpected fetch: ${url}`)
  }) as FetchLike
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
    const db = openDb(':memory:')
    const channel = scoutedChannel() // minScore 60
    const fetchImpl = fetchStub({
      '/r/space/hot.json': redditJson([
        { name: 't3_aaa', title: 'Moon drifting measured' },
        { name: 't3_bbb', title: 'Buy my telescope (ad)' },
      ]),
    })
    const { client, create } = fakeClient(
      emitScores([
        { candidateIndex: 0, score: 85, topic: 'The Moon is escaping Earth', reason: 'novel physics hook' },
        { candidateIndex: 1, score: 10, topic: 'Telescope ad', reason: 'commercial spam' },
      ]),
    )
    const result = await scoutChannel(db, channel, { client, fetchImpl })
    expect(result).toEqual({
      channel: 'chan-a',
      fetched: 2,
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
      { job_id: 'scout:chan-a', provider: 'anthropic', operation: 'scout-score', usd_micros: 2_000 },
    ])
    // ONE batched call for the whole channel
    expect(create).toHaveBeenCalledTimes(1)
    db.close()
  })

  it('re-runs are free: known hashes are filtered before the Haiku call', async () => {
    const db = openDb(':memory:')
    const channel = scoutedChannel()
    const fetchImpl = fetchStub({
      '/r/space/hot.json': redditJson([{ name: 't3_aaa', title: 'Moon drifting' }]),
    })
    const { client, create } = fakeClient(
      emitScores([{ candidateIndex: 0, score: 20, topic: 'Moon', reason: 'dull' }]),
    )
    await scoutChannel(db, channel, { client, fetchImpl })
    const second = await scoutChannel(db, channel, { client, fetchImpl })
    expect(second).toEqual({
      channel: 'chan-a',
      fetched: 1,
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
    const db = openDb(':memory:')
    const channel = scoutedChannel({ subreddits: ['space', 'askscience'] })
    const fetchImpl = fetchStub({
      '/r/space/hot.json': new Error('connect timeout'),
      '/r/askscience/hot.json': redditJson([{ name: 't3_ccc', title: 'Why is the sky blue' }]),
    })
    const { client } = fakeClient(
      emitScores([{ candidateIndex: 0, score: 70, topic: 'Sky color explained', reason: 'classic' }]),
    )
    const result = await scoutChannel(db, channel, { client, fetchImpl })
    expect(result.fetched).toBe(1)
    expect(result.queued).toBe(1)
    expect(result.sourceErrors).toHaveLength(1)
    // entries are prefixed with the failing source's id
    expect(result.sourceErrors[0]).toMatch(/^reddit:r\/space: /)
    db.close()
  })

  it('gates on the global day budget BEFORE spending', async () => {
    vi.stubEnv('BRAINROT_GLOBAL_DAILY_USD', '0')
    const db = openDb(':memory:')
    const channel = scoutedChannel()
    const fetchImpl = fetchStub({
      '/r/space/hot.json': redditJson([{ name: 't3_aaa', title: 'Moon drifting' }]),
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
    const db = openDb(':memory:')
    const channel = scoutedChannel()
    const fetchImpl = fetchStub({
      '/r/space/hot.json': redditJson([{ name: 't3_aaa', title: 'Moon drifting' }]),
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
})
