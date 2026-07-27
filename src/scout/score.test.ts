import { describe, expect, it, vi } from 'vitest'
import type Anthropic from '@anthropic-ai/sdk'
import { PRICE_TABLE } from '../providers/anthropic.js'
import type { TrendCandidate } from './sources/types.js'
import {
  ESTIMATED_SCOUT_COST_MICROS,
  SCOUT_MAX_TOKENS,
  SCOUT_MODEL,
  candidateLine,
  scoreCandidates,
} from './score.js'

// Client injection seam (script.test.ts pattern): a plain object with a
// vi.fn() create — vitest constructor mocks are never needed here.
function fakeClient(response: unknown): { client: Anthropic; create: ReturnType<typeof vi.fn> } {
  const create = vi.fn().mockResolvedValue(response)
  return { client: { messages: { create } } as unknown as Anthropic, create }
}

function candidate(i: number, overrides: Partial<TrendCandidate> = {}): TrendCandidate {
  return {
    title: `Headline ${i}`,
    url: `https://example.com/${i}`,
    sourceId: 'reddit:r/space',
    externalId: `t3_${i}`,
    ...overrides,
  }
}

function emit(scores: unknown, usage = { input_tokens: 1000, output_tokens: 500 }) {
  return {
    content: [{ type: 'tool_use', name: 'emit', id: 't1', input: { scores } }],
    usage,
  }
}

describe('candidateLine', () => {
  it('annotates a link candidate with its target host', () => {
    expect(
      candidateLine(
        candidate(0, {
          title: "Markarian's Chain",
          postKind: 'link',
          targetUrl: 'https://app.astrobin.com/u/x?i=y',
        }),
        0,
      ),
    ).toBe("0. [reddit:r/space] (link -> app.astrobin.com) Markarian's Chain")
  })

  it('annotates a self post without a host', () => {
    expect(
      candidateLine(
        candidate(1, {
          title: 'Are the edges of the universe equally far?',
          postKind: 'self',
          targetUrl: 'https://www.reddit.com/r/x/comments/y/',
        }),
        1,
      ),
    ).toBe('1. [reddit:r/space] (self post) Are the edges of the universe equally far?')
  })

  it('renders an unannotated RSS candidate exactly as before', () => {
    expect(
      candidateLine(
        candidate(2, { title: 'A galaxy assembles', sourceId: 'rss:phys.org' }),
        2,
      ),
    ).toBe('2. [rss:phys.org] A galaxy assembles')
  })

  it('omits the host when the target is unparseable', () => {
    expect(
      candidateLine(candidate(3, { title: 'Odd one', postKind: 'link', targetUrl: 'not a url' }), 3),
    ).toBe('3. [reddit:r/space] (link) Odd one')
  })
})

describe('scout scoring constants', () => {
  it('pins the haiku alias (a PRICE_TABLE key), token ceiling, and cost estimate', () => {
    expect(SCOUT_MODEL).toBe('claude-haiku-4-5')
    // The alias must be a PRICE_TABLE key or structuredCompletion refuses the
    // call at zero spend — this is why the dated model id would be wrong here.
    expect(PRICE_TABLE[SCOUT_MODEL]).toBeDefined()
    expect(SCOUT_MAX_TOKENS).toBe(4096)
    expect(ESTIMATED_SCOUT_COST_MICROS).toBe(20_000)
  })
})

describe('scoreCandidates', () => {
  it('makes one forced-tool haiku call carrying candidates, niche, and recent titles', async () => {
    const { client, create } = fakeClient(
      emit([
        { candidateIndex: 0, score: 91, topic: 'Watch the moon leave', reason: 'strong hook' },
        { candidateIndex: 1, score: 55, topic: 'Chase the solar wind', reason: 'niche fit' },
      ]),
    )
    await scoreCandidates({
      candidates: [
        candidate(0),
        candidate(1, { sourceId: 'rss:example.com', title: 'Solar wind news' }),
      ],
      niche: ['space facts', 'astronomy'],
      recentTitles: ['Old moon topic'],
      client,
    })
    expect(create).toHaveBeenCalledTimes(1)
    const sent = create.mock.calls[0][0]
    expect(sent.model).toBe(SCOUT_MODEL)
    expect(sent.max_tokens).toBe(SCOUT_MAX_TOKENS)
    expect(sent.tool_choice).toEqual({ type: 'tool', name: 'emit' })
    expect(sent.tools[0].input_schema.required).toContain('scores')
    // strict tool schemas reject minimum/maximum on integer properties
    // (observed live: 400 invalid_request_error "For 'integer' type, properties
    // maximum, minimum are not supported"). Bounds live in normalization instead.
    expect(JSON.stringify(sent.tools[0].input_schema)).not.toContain('"minimum"')
    expect(JSON.stringify(sent.tools[0].input_schema)).not.toContain('"maximum"')
    expect(sent.system).toContain('space facts, astronomy')
    const prompt = sent.messages[0].content as string
    // numbered list: index, sourceId, raw title — one line per candidate
    expect(prompt).toContain('0. [reddit:r/space] Headline 0')
    expect(prompt).toContain('1. [rss:example.com] Solar wind news')
    // the semantic-dedupe instruction and the recent titles it governs
    expect(prompt).toContain('covered — score near-duplicates 0')
    expect(prompt).toContain('- Old moon topic')
  })

  it('returns entries matched to candidates plus the billed haiku cost', async () => {
    const scores = [
      { candidateIndex: 0, score: 91, topic: 'Watch the moon leave', reason: 'strong hook' },
      { candidateIndex: 1, score: 55, topic: 'Chase the solar wind', reason: 'niche fit' },
    ]
    const { client } = fakeClient(emit(scores, { input_tokens: 1000, output_tokens: 500 }))
    const result = await scoreCandidates({
      candidates: [candidate(0), candidate(1)],
      niche: ['space facts'],
      recentTitles: [],
      client,
    })
    expect(result.scored).toEqual(scores)
    // haiku list price: 1 usd-micro per input token, 5 per output token
    expect(result.costUsdMicros).toBe(1000 * 1 + 500 * 5)
  })
})

describe('scoreCandidates normalization', () => {
  it('drops out-of-range indexes, keeps the first duplicate, fills absentees with score 0', async () => {
    const { client } = fakeClient(
      emit([
        { candidateIndex: 7, score: 99, topic: 'Ghost entry', reason: 'out of range' },
        { candidateIndex: 1, score: 80, topic: 'Kept entry', reason: 'first wins' },
        { candidateIndex: 1, score: 10, topic: 'Dropped dupe', reason: 'second loses' },
      ]),
    )
    const result = await scoreCandidates({
      candidates: [candidate(0), candidate(1), candidate(2)],
      niche: ['space facts'],
      recentTitles: [],
      client,
    })
    expect(result.scored).toEqual([
      { candidateIndex: 0, score: 0, topic: 'Headline 0', reason: 'not scored' },
      { candidateIndex: 1, score: 80, topic: 'Kept entry', reason: 'first wins' },
      { candidateIndex: 2, score: 0, topic: 'Headline 2', reason: 'not scored' },
    ])
  })

  it('clamps out-of-bounds scores and drops negative indexes (bounds left out of the wire schema)', async () => {
    const { client } = fakeClient(
      emit([
        { candidateIndex: -1, score: 50, topic: 'Negative ghost', reason: 'dropped' },
        { candidateIndex: 0, score: 150, topic: 'Too hot', reason: 'clamped down' },
        { candidateIndex: 1, score: -20, topic: 'Too cold', reason: 'clamped up' },
      ]),
    )
    const result = await scoreCandidates({
      candidates: [candidate(0), candidate(1)],
      niche: ['space facts'],
      recentTitles: [],
      client,
    })
    expect(result.scored).toEqual([
      { candidateIndex: 0, score: 100, topic: 'Too hot', reason: 'clamped down' },
      { candidateIndex: 1, score: 0, topic: 'Too cold', reason: 'clamped up' },
    ])
  })

  it('an empty scores list falls back to all zero-score entries', async () => {
    const { client } = fakeClient(emit([]))
    const result = await scoreCandidates({
      candidates: [candidate(0), candidate(1)],
      niche: ['space facts'],
      recentTitles: [],
      client,
    })
    expect(result.scored).toEqual([
      { candidateIndex: 0, score: 0, topic: 'Headline 0', reason: 'not scored' },
      { candidateIndex: 1, score: 0, topic: 'Headline 1', reason: 'not scored' },
    ])
  })
})
