import type { Database } from 'better-sqlite3'
import type Anthropic from '@anthropic-ai/sdk'
import type { ChannelConfig } from '../config/channel.js'
import { assertGlobalDayBudget, recordCost } from '../jobs/costs.js'
import { errorCostUsdMicros } from '../providers/errors.js'
import { dedupeHash, SOURCE_FETCH_TIMEOUT_MS } from './sources/types.js'
import type { FetchLike, TrendCandidate, TrendSource } from './sources/types.js'
import { redditSource } from './sources/reddit.js'
import { rssSource } from './sources/rss.js'
import { ESTIMATED_SCOUT_COST_MICROS, scoreCandidates } from './score.js'
import type { ScoredCandidate } from './score.js'
import { insertTopics, knownHashes, recentTopicTitles } from './topics.js'
import type { NewTopic } from './topics.js'

export interface ScoutChannelResult {
  channel: string
  fetched: number
  alreadyKnown: number
  scored: number
  queued: number
  rejected: number
  sourceErrors: string[]
  costUsdMicros: number
  scoringError?: string
}

// Carries the partial ScoutChannelResult across scoutChannel's rethrow so
// scoutAll can report real fetch/dedupe counts for a channel whose scoring
// failed. Module-private symbol: the original error identity must survive
// (callers match on BudgetExceededError / ZodError).
const PARTIAL_RESULT = Symbol('scout-partial-result')

function attachPartial(err: unknown, partial: ScoutChannelResult): void {
  if (err !== null && typeof err === 'object') {
    ;(err as Record<PropertyKey, unknown>)[PARTIAL_RESULT] = partial
  }
}

function readPartial(err: unknown): ScoutChannelResult | undefined {
  if (err !== null && typeof err === 'object' && PARTIAL_RESULT in err) {
    return (err as Record<PropertyKey, unknown>)[PARTIAL_RESULT] as ScoutChannelResult
  }
  return undefined
}

// Scoring with the ledger-complete error path: gate first; if the call spent
// before failing (paid-but-invalid response), record that spend before the
// error propagates.
async function scoreWithLedger(
  db: Database,
  channel: ChannelConfig,
  fresh: { candidate: TrendCandidate; hash: string }[],
  result: ScoutChannelResult,
  client?: Anthropic,
): Promise<{ scored: ScoredCandidate[]; costUsdMicros: number }> {
  try {
    // The scout has no job row to hang assertBudget on; gate the estimated
    // spend against the global daily cap directly (design spec §8).
    assertGlobalDayBudget(db, ESTIMATED_SCOUT_COST_MICROS)
    return await scoreCandidates({
      candidates: fresh.map((f) => f.candidate),
      niche: channel.niche,
      recentTitles: recentTopicTitles(db, channel.name),
      client,
    })
  } catch (err) {
    const spent = errorCostUsdMicros(err)
    if (spent !== undefined) {
      recordCost(db, `scout:${channel.name}`, 'anthropic', 'scout-score', spent)
      result.costUsdMicros = spent
    }
    attachPartial(err, result)
    throw err
  }
}

export async function scoutChannel(
  db: Database,
  channel: ChannelConfig,
  opts: { client?: Anthropic; fetchImpl?: FetchLike } = {},
): Promise<ScoutChannelResult> {
  const sources: TrendSource[] = [
    ...channel.scout.subreddits.map((sub) => redditSource(sub, opts.fetchImpl)),
    ...channel.scout.rss.map((feed) => rssSource(feed, opts.fetchImpl)),
  ]

  const sourceErrors: string[] = []
  const candidates: TrendCandidate[] = []
  // Per-source isolation: a failed or timed-out source contributes zero
  // candidates and one sourceErrors entry; the run continues (design spec §4).
  for (const source of sources) {
    try {
      candidates.push(
        ...(await source.fetch({
          limit: channel.scout.perSourceLimit,
          timeoutMs: SOURCE_FETCH_TIMEOUT_MS,
        })),
      )
    } catch (err) {
      const entry = `${source.id}: ${err instanceof Error ? err.message : String(err)}`
      // Spec §4: a failing source "logs a warning" — stderr, since stdout is
      // reserved for the CLI's single JSON line.
      console.error(`scout: source ${entry}`)
      sourceErrors.push(entry)
    }
  }

  const result: ScoutChannelResult = {
    channel: channel.name,
    fetched: candidates.length,
    alreadyKnown: 0,
    scored: 0,
    queued: 0,
    rejected: 0,
    sourceErrors,
    costUsdMicros: 0,
  }

  // Hash-filter BEFORE scoring: known items never reach Haiku again, so scout
  // re-runs are free and rejected topics stay rejected without re-spend.
  const hashes = candidates.map((c) => dedupeHash(c.sourceId, c.externalId))
  const known = knownHashes(db, channel.name, hashes)
  const fresh = candidates
    .map((candidate, i) => ({ candidate, hash: hashes[i] }))
    .filter((f) => !known.has(f.hash))
  result.alreadyKnown = candidates.length - fresh.length
  if (fresh.length === 0) return result

  result.scored = fresh.length
  const scored = await scoreWithLedger(db, channel, fresh, result, opts.client)
  result.costUsdMicros = scored.costUsdMicros
  // Sentinel job id: FKs are off by design, and the global-day query sums ALL
  // costs rows, so scout spend counts toward the operator ceiling.
  recordCost(db, `scout:${channel.name}`, 'anthropic', 'scout-score', scored.costUsdMicros)

  const rows: NewTopic[] = scored.scored.map((s) => {
    const { candidate, hash } = fresh[s.candidateIndex]
    return {
      channel: channel.name,
      title: s.topic,
      rawTitle: candidate.title,
      source: candidate.sourceId,
      url: candidate.url,
      dedupeHash: hash,
      score: s.score,
      reason: s.reason,
      // At/above the channel threshold → production queue; below → remembered
      // rejection (the hash filter keeps it away from Haiku forever).
      status: s.score >= channel.scout.minScore ? 'candidate' : 'rejected',
    }
  })
  result.queued = rows.filter((r) => r.status === 'candidate').length
  result.rejected = rows.length - result.queued
  insertTopics(db, rows)
  return result
}

export class AllSourcesFailedError extends Error {
  // Carries the per-channel results so the CLI can still print its one JSON
  // line (Global Constraints: JSON even on failure outcomes) before exit 1.
  constructor(message: string, public results: ScoutChannelResult[]) {
    super(message)
    this.name = 'AllSourcesFailedError'
  }
}

export async function scoutAll(
  db: Database,
  channels: ChannelConfig[],
  opts: { client?: Anthropic; fetchImpl?: FetchLike } = {},
): Promise<ScoutChannelResult[]> {
  const results: ScoutChannelResult[] = []
  let totalSources = 0
  let failedSources = 0
  for (const channel of channels) {
    const sourceCount = channel.scout.subreddits.length + channel.scout.rss.length
    // No [scout] sources → not a scouted channel; manual produce only.
    if (sourceCount === 0) continue
    totalSources += sourceCount
    try {
      const result = await scoutChannel(db, channel, opts)
      failedSources += result.sourceErrors.length
      results.push(result)
    } catch (err) {
      // Per-channel isolation: one channel's scoring failure (including the
      // global-day budget gate) must not starve the others.
      const message = err instanceof Error ? err.message : String(err)
      console.error(`scout: channel "${channel.name}" scoring failed: ${message}`)
      const partial = readPartial(err) ?? {
        channel: channel.name,
        fetched: 0,
        alreadyKnown: 0,
        scored: 0,
        queued: 0,
        rejected: 0,
        sourceErrors: [],
        costUsdMicros: 0,
      }
      failedSources += partial.sourceErrors.length
      // queued/rejected are 0 on the error path by contract — nothing was inserted.
      results.push({ ...partial, queued: 0, rejected: 0, scoringError: message })
    }
  }
  if (totalSources > 0 && failedSources === totalSources) {
    throw new AllSourcesFailedError(
      `all ${totalSources} trend source(s) across ${results.length} channel(s) failed`,
      results,
    )
  }
  return results
}
