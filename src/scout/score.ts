import type Anthropic from '@anthropic-ai/sdk'
import { z } from 'zod'
import { structuredCompletion } from '../providers/anthropic.js'
import { retagWithContext } from '../errors.js'
import { errorCostUsdMicros } from '../providers/errors.js'
import type { TrendCandidate } from './sources/types.js'

// The alias, NOT the dated model id: it is the PRICE_TABLE key in
// src/providers/anthropic.ts, so cost computation resolves before the call.
export const SCOUT_MODEL = 'claude-haiku-4-5'
export const SCOUT_MAX_TOKENS = 4096
// A single forced-tool call scoring every fetched candidate at once can
// overflow SCOUT_MAX_TOKENS once a channel's fetch returns enough candidates
// (observed live: 75 candidates truncated the emit call mid-generation,
// failing schema validation with "scores" missing entirely). Chunking bounds
// per-call output regardless of batch size.
export const SCOUT_SCORE_CHUNK_SIZE = 20
// Typical-cost reservation for ONE chunked call (mirrors
// ESTIMATED_SCRIPT_COST_MICROS): the scout orchestrator multiplies this by
// estimatedChunkCount() and gates it against the global day cap before
// calling, then trues up from response.usage after.
export const ESTIMATED_SCOUT_COST_MICROS = 20_000
// How much of a story's opening the scorer sees. The first ~150 words are the
// span that decides whether a viewer keeps watching, and capping there keeps
// input bounded regardless of a 7,000-word r/nosleep post.
export const STORY_SCORE_PREVIEW_WORDS = 150

export function estimatedChunkCount(candidateCount: number): number {
  return Math.max(1, Math.ceil(candidateCount / SCOUT_SCORE_CHUNK_SIZE))
}

export interface ScoredCandidate {
  candidateIndex: number
  score: number
  topic: string
  reason: string
}

// No numeric bounds here: the strict tool-schema mode rejects minimum/maximum
// on integer properties (live 400: "For 'integer' type, properties maximum,
// minimum are not supported"). Range rules live in the prompt and are enforced
// by normalization below — negative indexes are dropped, scores clamped 0-100.
const ScoresSchema = z.object({
  scores: z.array(
    z.object({
      candidateIndex: z.number().int(),
      score: z.number().int(),
      topic: z.string().min(1),
      reason: z.string().min(1),
    }),
  ),
})

function buildSystem(niche: string[]): string {
  return [
    `You are a trend scout for a short-form video channel in the "${niche.join(', ')}" niche.`,
    'You rate scraped headlines 0-100 on their potential as retention-optimized vertical video topics for that niche.',
    'For each candidate you also reframe the headline into a hooky, imperative video topic and give a one-line reason for the score.',
    'Return your answer ONLY by calling the `emit` tool. Never write prose or markdown.',
  ].join(' ')
}

// A candidate's annotation, when it has one. Only the target HOST is shown,
// never the full URL: the host is what carries the signal (app.astrobin.com
// is an image host, theguardian.com is not), and a full URL would spend
// tokens on per-post ids that mean nothing to the scorer.
function targetHost(targetUrl: string | undefined): string | undefined {
  if (targetUrl === undefined) return undefined
  try {
    return new URL(targetUrl).hostname
  } catch {
    return undefined
  }
}

// Truncates a story candidate's body to the preview budget. Splitting on
// whitespace (not slicing chars) keeps the cut on a word boundary regardless
// of the source's line breaks or spacing.
function bodyPreview(body: string | undefined): string | undefined {
  if (body === undefined) return undefined
  const tokens = body.split(/\s+/)
  const head = tokens.slice(0, STORY_SCORE_PREVIEW_WORDS).join(' ')
  return tokens.length > STORY_SCORE_PREVIEW_WORDS ? `${head} …` : head
}

/**
 * One prompt line per candidate. Reddit candidates carry what the title alone
 * cannot say — whether the post is a story or a link, and where the link
 * points — which is what lets the scorer penalize an image host it has never
 * been told about. 'image' needs no branch: scoutChannel drops those before
 * scoring, and one arriving here would render as a link, the safe direction.
 *
 * In story mode the branch is different: a self post is judged on its
 * opening, not on its link target, so the postKind/host annotations below
 * carry no signal and are replaced with a truncated body preview instead.
 */
export function candidateLine(c: TrendCandidate, index: number, story = false): string {
  const prefix = `${index}. [${c.sourceId}]`
  if (story) {
    const preview = bodyPreview(c.body)
    return preview === undefined ? `${prefix} ${c.title}` : `${prefix} ${c.title}\n   ${preview}`
  }
  if (c.postKind === undefined) return `${prefix} ${c.title}`
  if (c.postKind === 'self') return `${prefix} (self post) ${c.title}`
  const host = targetHost(c.targetUrl)
  const annotation = host === undefined ? '(link)' : `(link -> ${host})`
  return `${prefix} ${annotation} ${c.title}`
}

function buildPrompt(
  candidates: TrendCandidate[],
  niche: string[],
  recent: string,
  offset: number,
): string {
  const list = candidates.map((c, i) => candidateLine(c, offset + i)).join('\n')
  return `Score each candidate headline as a video topic for the "${niche.join(', ')}" niche.

Candidates (score every one by its index):
${list}

Recently covered — score near-duplicates 0:
${recent}

For each candidate return:
- candidateIndex: the number from the list above
- score: 0 to 100 — how strong a short-form vertical video this makes for the niche (0 = off-niche, stale, or already covered)
- topic: the headline reframed as a hooky video topic, imperative and concrete
- reason: one line explaining the score

Scoring rules:
- A candidate whose link target is a photograph, image gallery, or image-hosting page has no narrative substance. Score it low even when the subject is on-niche — a picture is not a story.
- A self post is the poster's own question or story. Judge it on whether the question has a factual, explainable answer.`
}

function buildStorySystem(niche: string[]): string {
  return [
    `You are a story scout for a short-form video channel in the "${niche.join(', ')}" niche.`,
    'The channel narrates reddit posts VERBATIM, so you are rating the post itself, not a topic to research.',
    'You rate each post 0-100 on how well it works as a narrated vertical video, write a hooky title for it, and give a one-line reason.',
    'Return your answer ONLY by calling the `emit` tool. Never write prose or markdown.',
  ].join(' ')
}

function buildStoryPrompt(candidates: TrendCandidate[], recent: string, offset: number): string {
  const list = candidates.map((c, i) => candidateLine(c, offset + i, true)).join('\n')
  return `Score each reddit post below as a verbatim-narrated short video.

Posts (score every one by its index; the indented line is the post's opening):
${list}

Recently covered — score near-duplicates 0:
${recent}

For each candidate return:
- candidateIndex: the number from the list above
- score: 0 to 100
- topic: the post retitled as a hooky video title, concrete and specific. Do not include a part number.
- reason: one line explaining the score

Scoring rules:
- Judge the OPENING: does it establish a concrete conflict with real stakes within the first few sentences, and is there a clear question the viewer wants answered?
- Reward specific, unusual, personal detail. Penalize vague setups, advice requests with no incident, and posts that are mostly background context.
- A post with no story in it — an announcement, a poll, a meta discussion about the subreddit — scores 0.

Content rule — apply a HIGH bar, and score 0 ONLY for material that could not be published at all:
- sexual content involving minors
- graphic sexual detail
- explicit depiction of self-harm or suicide method
- graphic violence or gore described in detail
State which one in the reason when you use it.
This rule is deliberately narrow. Ordinary conflict, infidelity, divorce, family estrangement, workplace disputes, and non-graphic references to violence, death, or abuse are the genre — they are NOT disqualifying and must be scored on story quality alone.`
}

// Pure scoring: no db access here — budget gating and cost ledgering live in
// scoutChannel, which owns the 'scout:<channel>' sentinel rows.
//
// Chunks are scored sequentially, not concurrently: this keeps cost
// accumulation and the partial-spend-on-failure path simple, and scout runs
// are not latency-sensitive (20-minute recheck cadence per channel).
export async function scoreCandidates(opts: {
  candidates: TrendCandidate[]
  niche: string[]
  recentTitles: string[]
  story?: boolean
  client?: Anthropic
}): Promise<{ scored: ScoredCandidate[]; costUsdMicros: number }> {
  const byIndex = new Map<number, ScoredCandidate>()
  let totalCostUsdMicros = 0
  const story = opts.story === true
  const system = story ? buildStorySystem(opts.niche) : buildSystem(opts.niche)
  const recent =
    opts.recentTitles.length > 0 ? opts.recentTitles.map((t) => `- ${t}`).join('\n') : '(none)'

  try {
    for (let offset = 0; offset < opts.candidates.length; offset += SCOUT_SCORE_CHUNK_SIZE) {
      const chunk = opts.candidates.slice(offset, offset + SCOUT_SCORE_CHUNK_SIZE)
      const { data, cost } = await structuredCompletion({
        model: SCOUT_MODEL,
        system,
        prompt: story
          ? buildStoryPrompt(chunk, recent, offset)
          : buildPrompt(chunk, opts.niche, recent, offset),
        schema: ScoresSchema,
        maxTokens: SCOUT_MAX_TOKENS,
        client: opts.client,
      })
      totalCostUsdMicros += cost.usdMicros

      // The model's list is untrusted: out-of-range indexes (either side) are
      // dropped, scores are clamped to 0-100 (the wire schema cannot carry
      // bounds), a duplicated index keeps its first entry, and any candidate
      // the model skipped scores 0 — it lands 'rejected' in the queue instead
      // of vanishing.
      for (const entry of data.scores) {
        if (entry.candidateIndex < 0 || entry.candidateIndex >= opts.candidates.length) continue
        if (byIndex.has(entry.candidateIndex)) continue
        byIndex.set(entry.candidateIndex, {
          ...entry,
          score: Math.min(100, Math.max(0, entry.score)),
        })
      }
    }
  } catch (err) {
    // Carry forward every prior chunk's already-billed spend plus this
    // chunk's own (the provider bills a paid-but-invalid response too), so
    // the caller ledgers the true multi-call cost instead of only the
    // failing chunk's.
    const chunkCost = errorCostUsdMicros(err) ?? 0
    throw retagWithContext(err, { costUsdMicros: totalCostUsdMicros + chunkCost })
  }

  const scored = opts.candidates.map(
    (c, i) =>
      byIndex.get(i) ?? { candidateIndex: i, score: 0, topic: c.title, reason: 'not scored' },
  )
  return { scored, costUsdMicros: totalCostUsdMicros }
}
