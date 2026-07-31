import { describe, expect, it, vi } from 'vitest'
import type Anthropic from '@anthropic-ai/sdk'
import { llmSource, normalizeGeneratedTitle } from './llm.js'

// Client injection seam (score.test.ts pattern): a plain object with a
// vi.fn() create — vitest constructor mocks are never needed here.
function fakeClient(response: unknown): { client: Anthropic; create: ReturnType<typeof vi.fn> } {
  const create = vi.fn().mockResolvedValue(response)
  return { client: { messages: { create } } as unknown as Anthropic, create }
}

function emit(topics: unknown, usage = { input_tokens: 1000, output_tokens: 500 }) {
  return {
    content: [{ type: 'tool_use', name: 'emit', id: 't1', input: { topics } }],
    usage,
  }
}

describe('llmSource', () => {
  it('returns one candidate per generated title with llm dedupe identity', async () => {
    const { client } = fakeClient(emit([{ title: 'Why the Moon rings like a bell' }]))
    const source = llmSource({
      channelName: 'test',
      niche: ['space facts'],
      recentTitles: [],
      count: 5,
      client,
    })
    const result = await source.fetch({ limit: 10, timeoutMs: 5000 })
    expect(result).toEqual([
      {
        title: 'Why the Moon rings like a bell',
        url: '',
        sourceId: 'llm:test',
        externalId: 'why the moon rings like a bell',
      },
    ])
  })

  it('caps results at opts.count and at fetch limit', async () => {
    const { client, create } = fakeClient(
      emit([
        { title: 'Topic A' },
        { title: 'Topic B' },
        { title: 'Topic C' },
        { title: 'Topic D' },
      ]),
    )
    const source = llmSource({
      channelName: 'test',
      niche: ['space facts'],
      recentTitles: [],
      count: 10,
      client,
    })
    // fetch limit (2) is stricter than opts.count (10)
    const result = await source.fetch({ limit: 2, timeoutMs: 5000 })
    expect(result).toHaveLength(2)
    // the requested generation count sent to the model must respect the
    // tighter of count/limit, not just the truncation afterward
    const sent = create.mock.calls[0][0]
    const prompt = sent.messages[0].content as string
    expect(prompt).toContain('Generate 2 candidate')
  })

  it('drops duplicate titles within one batch (normalized compare)', async () => {
    const { client } = fakeClient(
      emit([
        { title: 'Why the Moon rings like a bell' },
        { title: '  WHY the moon   rings like a bell  ' },
        { title: 'A different topic entirely' },
      ]),
    )
    const source = llmSource({
      channelName: 'test',
      niche: ['space facts'],
      recentTitles: [],
      count: 10,
      client,
    })
    const result = await source.fetch({ limit: 10, timeoutMs: 5000 })
    expect(result).toHaveLength(2)
    expect(result.map((c) => c.externalId)).toEqual([
      'why the moon rings like a bell',
      'a different topic entirely',
    ])
  })

  it('reports spend through onCost', async () => {
    const { client } = fakeClient(
      emit([{ title: 'Topic A' }], { input_tokens: 1000, output_tokens: 500 }),
    )
    const onCost = vi.fn()
    const source = llmSource({
      channelName: 'test',
      niche: ['space facts'],
      recentTitles: [],
      count: 5,
      client,
      onCost,
    })
    await source.fetch({ limit: 10, timeoutMs: 5000 })
    // haiku list price: 1 usd-micro per input token, 5 per output token
    expect(onCost).toHaveBeenCalledWith(1000 * 1 + 500 * 5)
  })

  it('renders recent titles into the prompt so regenerations are steered away', async () => {
    const { client, create } = fakeClient(emit([{ title: 'Topic A' }]))
    const source = llmSource({
      channelName: 'test',
      niche: ['space facts'],
      recentTitles: ['A previously covered topic'],
      count: 5,
      client,
    })
    await source.fetch({ limit: 10, timeoutMs: 5000 })
    const sent = create.mock.calls[0][0]
    const prompt = sent.messages[0].content as string
    expect(prompt).toContain('A previously covered topic')
  })
})

describe('normalizeGeneratedTitle', () => {
  it('lowercases, collapses whitespace, and trims', () => {
    expect(normalizeGeneratedTitle('  WHY the   Moon Rings  ')).toBe('why the moon rings')
  })
})
