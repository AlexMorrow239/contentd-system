import type Anthropic from '@anthropic-ai/sdk'
import { z } from 'zod'
import { structuredCompletion } from '../../providers/anthropic.js'
import { SCOUT_MODEL } from '../score.js'
import type { TrendCandidate, TrendSource, TrendSourceFetchOpts } from './types.js'

// Same reservation shape as ESTIMATED_SCOUT_COST_MICROS: gated against the
// global day cap by scoutChannel before the call, trued up from usage after.
export const ESTIMATED_GENERATE_COST_MICROS = 20_000

// A generated topic has no external identity, so its normalized title IS its
// externalId: exact regenerations dedupe through the ordinary
// (sourceId, externalId) hash, and near-duplicates are the scorer's job (its
// recent-titles window already scores them 0).
export function normalizeGeneratedTitle(title: string): string {
  return title.toLowerCase().replace(/\s+/g, ' ').trim()
}

const TopicsSchema = z.object({
  topics: z.array(z.object({ title: z.string().min(1) })),
})

export interface LlmSourceOpts {
  channelName: string
  niche: string[]
  recentTitles: string[]
  count: number
  client?: Anthropic
  // TrendSource.fetch returns only candidates, so successful-call spend rides
  // out through this callback; failed-call spend rides the thrown error's
  // cost tag (errorCostUsdMicros), same as every provider call.
  onCost?: (usdMicros: number) => void
}

export function llmSource(opts: LlmSourceOpts): TrendSource {
  const id = `llm:${opts.channelName}`
  return {
    id,
    async fetch(fetchOpts: TrendSourceFetchOpts): Promise<TrendCandidate[]> {
      const count = Math.min(opts.count, fetchOpts.limit)
      const recent =
        opts.recentTitles.length > 0 ? opts.recentTitles.map((t) => `- ${t}`).join('\n') : '(none)'
      const { data, cost } = await structuredCompletion({
        model: SCOUT_MODEL,
        system:
          `You are a topic generator for a short-form vertical video channel in the "${opts.niche.join(', ')}" niche. ` +
          'You invent concrete, surprising, factually-grounded topic headlines with strong retention potential. ' +
          'Return your answer ONLY by calling the `emit` tool. Never write prose or markdown.',
        prompt: `Generate ${count} candidate video topics for the "${opts.niche.join(', ')}" niche.

Rules:
- Each topic must be concrete and specific — a claim, mystery, or fact a 45-second video can actually deliver, not a listicle or a vague theme.
- Every topic must clear a high editorial bar: a topic scout will reject anything generic, stale, or clickbait-without-substance.
- Avoid anything close to these recently covered titles:
${recent}

Return each as { title }.`,
        schema: TopicsSchema,
        client: opts.client,
      })
      opts.onCost?.(cost.usdMicros)
      const seen = new Set<string>()
      const out: TrendCandidate[] = []
      for (const t of data.topics) {
        const externalId = normalizeGeneratedTitle(t.title)
        if (externalId === '' || seen.has(externalId)) continue
        seen.add(externalId)
        // url '': a generated topic has no source page. topics.url is NOT
        // NULL, and '' renders as no link — same shape a viewer expects.
        out.push({ title: t.title.trim(), url: '', sourceId: id, externalId })
        if (out.length >= count) break
      }
      return out
    },
  }
}
