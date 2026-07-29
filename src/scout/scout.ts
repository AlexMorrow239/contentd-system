import type { Database } from 'better-sqlite3'
import type Anthropic from '@anthropic-ai/sdk'
import type { ChannelConfig } from '../config/channel.js'
import { assertGlobalDayBudget, recordCost } from '../jobs/costs.js'
import { BrainrotError, classify, errorMessage, retagWithContext } from '../errors.js'
import { errorCostUsdMicros } from '../providers/errors.js'
import { dedupeHash, SOURCE_FETCH_TIMEOUT_MS } from './sources/types.js'
import type { FetchLike, TrendCandidate, TrendSource } from './sources/types.js'
import { isMediaPostKind } from './sources/post-kind.js'
import { redditSource } from './sources/reddit.js'
import { rssSource } from './sources/rss.js'
import { ESTIMATED_SCOUT_COST_MICROS, estimatedChunkCount, scoreCandidates } from './score.js'
import type { ScoredCandidate } from './score.js'
import { candidateTopicCount, insertTopics, knownHashes, recentTopicTitles } from './topics.js'
import type { NewTopic } from './topics.js'
import { lastScoutAttemptAt, recordScoutAttempt } from './scout-state.js'

// The one score gate. A constant, not config (design 2026-07-28): topics
// below this are never stored, so the queue only ever holds topics worth
// producing. min_score was removed from channel TOML in the same change.
export const SCOUT_MIN_SCORE = 80

// The floor between two scout attempts for ONE channel, so a quiet subreddit
// isn't refetched on every 30-second daemon poll. Persisted in `scout_state`
// (not in-memory) so the gate survives a daemon restart and is shared with a
// manual `brainrot scout` run — see `--force` on that command to bypass it.
export const SCOUT_RECHECK_MS = 1_200_000 // 20 min

export interface ScoutChannelResult {
  channel: string
  fetched: number
  droppedMedia: number
  droppedAutomated: number
  alreadyKnown: number
  scored: number
  queued: number
  rejected: number
  sourceErrors: string[]
  costUsdMicros: number
  scoringError?: string
  /**
   * Set when the channel was not scouted at all. 'queue-full' means it already
   * holds queue_days' worth of candidates — a healthy outcome, not a failure.
   * 'recheck-not-due' means an attempt landed within SCOUT_RECHECK_MS of now.
   * Both are distinguishable from the all-zero result a channel with no fresh
   * candidates produces.
   */
  skipped?: 'queue-full' | 'recheck-not-due'
}

function emptySkippedResult(
  channel: string,
  skipped: NonNullable<ScoutChannelResult['skipped']>,
): ScoutChannelResult {
  return {
    channel,
    fetched: 0,
    droppedMedia: 0,
    droppedAutomated: 0,
    alreadyKnown: 0,
    scored: 0,
    queued: 0,
    rejected: 0,
    sourceErrors: [],
    costUsdMicros: 0,
    skipped,
  }
}

// A source before construction: the raw config entry the loop builds a source
// from inside the per-source try, so a throwing constructor is isolated.
type SourceDescriptor = { kind: 'reddit'; subreddit: string } | { kind: 'rss'; url: string }

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
    // spend against the global daily cap directly (design spec §8). Scored in
    // chunks now, so the estimate scales with how many calls this batch will
    // actually make.
    assertGlobalDayBudget(db, ESTIMATED_SCOUT_COST_MICROS * estimatedChunkCount(fresh.length))
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
    // Carry the partial ScoutChannelResult across the rethrow so scoutAll can
    // report real fetch/dedupe counts for a channel whose scoring failed.
    // Tagged rather than subclassed: the original error identity must survive
    // (callers match on BudgetExceededError / ZodError).
    throw retagWithContext(err, { partial: result })
  }
}

export async function scoutChannel(
  db: Database,
  channel: ChannelConfig,
  opts: { client?: Anthropic; fetchImpl?: FetchLike; now?: Date; force?: boolean } = {},
): Promise<ScoutChannelResult> {
  const now = opts.now ?? new Date()

  // Recheck gate FIRST — cheaper than the depth query below (a single indexed
  // lookup vs a COUNT), and a channel whose last attempt is still fresh has
  // nothing new to learn from either query.
  if (!opts.force) {
    const last = lastScoutAttemptAt(db, channel.name)
    if (last !== null && now.getTime() - last.getTime() < SCOUT_RECHECK_MS) {
      return emptySkippedResult(channel.name, 'recheck-not-due')
    }
  }
  // The attempt is recorded as soon as the channel clears the recheck gate —
  // BEFORE the queue-full check and before any fetch/score work — so the
  // clock bumps for every channel actually attempted (queue-full, real work,
  // or a scoring failure that throws below), matching what a caller means by
  // "we looked at this channel just now".
  recordScoutAttempt(db, channel.name, now)

  // Depth gate — ahead of the source loop, so a channel with enough queued
  // candidates costs neither a network fetch nor a Haiku scoring call. The
  // scoring calls are where the money is, so gating after fetching would save
  // almost nothing.
  const queueCap = Math.ceil(channel.videosPerDay * channel.scout.queueDays)
  if (candidateTopicCount(db, channel.name) >= queueCap) {
    return emptySkippedResult(channel.name, 'queue-full')
  }

  // Iterate DESCRIPTORS, not pre-built sources: rssSource runs `new URL(url)`
  // at construction, so building every source up front let one malformed feed
  // URL abort the whole channel before per-source isolation began. Constructing
  // inside the per-source try keeps a throwing constructor to a single entry.
  const descriptors: SourceDescriptor[] = [
    ...channel.scout.subreddits.map((subreddit) => ({ kind: 'reddit' as const, subreddit })),
    ...channel.scout.rss.map((url) => ({ kind: 'rss' as const, url })),
  ]

  const sourceErrors: string[] = []
  const candidates: TrendCandidate[] = []
  // Per-source isolation: a failed constructor, fetch, or timeout contributes
  // zero candidates and one sourceErrors entry; the run continues (spec §4).
  for (const descriptor of descriptors) {
    let source: TrendSource | undefined
    try {
      source =
        descriptor.kind === 'reddit'
          ? redditSource(descriptor.subreddit, opts.fetchImpl)
          : rssSource(descriptor.url, opts.fetchImpl)
      candidates.push(
        ...(await source.fetch({
          limit: channel.scout.perSourceLimit,
          timeoutMs: SOURCE_FETCH_TIMEOUT_MS,
        })),
      )
    } catch (err) {
      // Prefer the constructed source's id; when the constructor itself threw
      // (a malformed rss URL — no hostname to derive an id from) fall back to a
      // raw-url prefix so the entry still names the offending source.
      const id =
        source?.id ??
        (descriptor.kind === 'reddit'
          ? `reddit:r/${descriptor.subreddit}`
          : `rss:${descriptor.url}`)
      const entry = `${id}: ${errorMessage(err)}`
      // Spec §4: a failing source "logs a warning" — stderr, since stdout is
      // reserved for the CLI's single JSON line.
      console.error(`scout: source ${entry}`)
      sourceErrors.push(entry)
    }
  }

  // Policy lives here, not in the source: redditSource annotates, the scout
  // decides. An image post is a photograph with no narrative substance — the
  // scorer sees only titles, so "Milky way over Yosemite" reads as a strong
  // topic and scored 89. Dropping pre-scoring also means Haiku is never paid
  // to rate one.
  //
  // Dropped items get no topics row: re-dropping them next tick is free (the
  // filter is deterministic and pre-LLM), and the table keeps meaning "things
  // we actually considered".
  const notMedia = candidates.filter((c) => !isMediaPostKind(c.postKind))

  // The other thing the scorer cannot see: AutoModerator's recurring scheduled
  // threads. Each week's instance is a distinct t3_ id, so the dedupe filter
  // below never catches them — without this they cost a scoring slot every
  // week, forever, across every subreddit that runs one.
  const usable = notMedia.filter((c) => c.automated !== true)

  const result: ScoutChannelResult = {
    channel: channel.name,
    // fetched stays the raw count, so
    // fetched - droppedMedia - droppedAutomated - alreadyKnown reads as scored.
    fetched: candidates.length,
    droppedMedia: candidates.length - notMedia.length,
    droppedAutomated: notMedia.length - usable.length,
    alreadyKnown: 0,
    scored: 0,
    queued: 0,
    rejected: 0,
    sourceErrors,
    costUsdMicros: 0,
  }

  // Hash-filter BEFORE scoring: known items never reach Haiku again, so scout
  // re-runs are free and rejected topics stay rejected without re-spend.
  const hashes = usable.map((c) => dedupeHash(c.sourceId, c.externalId))
  const known = knownHashes(db, channel.name, hashes)
  const fresh = usable
    .map((candidate, i) => ({ candidate, hash: hashes[i] }))
    .filter((f) => !known.has(f.hash))
  result.alreadyKnown = usable.length - fresh.length
  if (fresh.length === 0) return result

  result.scored = fresh.length
  const scored = await scoreWithLedger(db, channel, fresh, result, opts.client)
  result.costUsdMicros = scored.costUsdMicros

  const rows: NewTopic[] = scored.scored.map((s) => {
    const { candidate, hash } = fresh[s.candidateIndex]
    return {
      channel: channel.name,
      title: s.topic,
      rawTitle: candidate.title,
      source: candidate.sourceId,
      url: candidate.url,
      targetUrl: candidate.targetUrl,
      dedupeHash: hash,
      score: s.score,
      reason: s.reason,
      // At/above SCOUT_MIN_SCORE → production queue; below → remembered
      // rejection (the hash filter keeps it away from Haiku forever).
      status: s.score >= SCOUT_MIN_SCORE ? 'candidate' : 'rejected',
    }
  })
  result.queued = rows.filter((r) => r.status === 'candidate').length
  result.rejected = rows.length - result.queued
  // Ledger row and dedupe hashes commit together: a kill between them would
  // keep the charge and lose the hashes, so the next run re-pays Haiku for the
  // very same items. better-sqlite3 nests insertTopics' own transaction as a
  // savepoint, so the wrap is safe.
  db.transaction(() => {
    // Sentinel job id: FKs are off by design, and the global-day query sums ALL
    // costs rows, so scout spend counts toward the operator ceiling.
    recordCost(db, `scout:${channel.name}`, 'anthropic', 'scout-score', scored.costUsdMicros)
    insertTopics(db, rows)
  })()
  return result
}

// Systemic scout failures: the run produced nothing for a reason no single
// channel's isolation can absorb. Both carry the per-channel results so the CLI
// can still print its one JSON line (Global Constraints: JSON even on failure
// outcomes) before exit 1.
export class ScoutRunFailedError extends BrainrotError {
  readonly results: ScoutChannelResult[]

  constructor(message: string, results: ScoutChannelResult[]) {
    // 'transient' because every cause is one — an expired key, a provider
    // outage, a source that will be back. The run failing is the signal; the
    // next scheduled scout is the retry.
    super(message, { domain: 'scout', kind: 'transient', context: { results } })
    this.name = 'ScoutRunFailedError'
    this.results = results
  }
}

export class AllSourcesFailedError extends ScoutRunFailedError {
  constructor(message: string, results: ScoutChannelResult[]) {
    super(message, results)
    this.name = 'AllSourcesFailedError'
  }
}

// Sources fetched fine but nothing could be scored anywhere (expired API key,
// provider outage, global-day cap): sourceErrors stays empty, so without this
// the run would look healthy while the queue quietly drains.
export class AllChannelsScoringFailedError extends ScoutRunFailedError {
  constructor(message: string, results: ScoutChannelResult[]) {
    super(message, results)
    this.name = 'AllChannelsScoringFailedError'
  }
}

// One scout pass per invocation, matching the other two loops. Generously above
// a full multi-channel fetch + Haiku scoring pass; a crashed holder self-heals
// by expiry rather than wedging the loop.
export const SCOUT_LEASE_TTL_MS = 1_800_000 // 30 min

export async function scoutAll(
  db: Database,
  channels: ChannelConfig[],
  opts: { client?: Anthropic; fetchImpl?: FetchLike; now?: Date; force?: boolean } = {},
): Promise<ScoutChannelResult[]> {
  const results: ScoutChannelResult[] = []
  // Channels that failed the budget gate rather than scoring itself. The
  // global day cap is GLOBAL, so once it is reached EVERY channel fails
  // identically — and a cap doing its job is a healthy outcome, not a failed
  // run. Counting these as failures made every scout firing exit 1 for the
  // rest of the UTC day. Names are unique (loadChannelsDir keys the file to
  // the channel name), so a Set of them indexes results exactly.
  const budgetBlocked = new Set<string>()
  let totalSources = 0
  let failedSources = 0
  for (const channel of channels) {
    const sourceCount = channel.scout.subreddits.length + channel.scout.rss.length
    // No [scout] sources → not a scouted channel; manual produce only.
    if (sourceCount === 0) continue
    try {
      const result = await scoutChannel(db, channel, opts)
      // A skipped channel never touched its sources, so it must not count
      // toward the all-sources-failed test — otherwise a fully-stocked
      // deployment would read as a total source outage.
      if (result.skipped === undefined) totalSources += sourceCount
      failedSources += result.sourceErrors.length
      results.push(result)
    } catch (err) {
      // A channel that threw did reach its sources (the gate returns, never
      // throws), so its sources still count.
      totalSources += sourceCount
      // Per-channel isolation: one channel's scoring failure (including the
      // global-day budget gate) must not starve the others.
      const info = classify(err)
      const message = info.message
      if (info.kind === 'budget') budgetBlocked.add(channel.name)
      console.error(`scout: channel "${channel.name}" scoring failed: ${message}`)
      const partial = (info.context.partial as ScoutChannelResult | undefined) ?? {
        channel: channel.name,
        fetched: 0,
        droppedMedia: 0,
        droppedAutomated: 0,
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
  // Sources were fine (checked first) yet every scouted channel died in
  // scoring: nothing was inserted anywhere, which is a failed run — not the
  // zero-topic healthy run a channel with no fresh candidates produces.
  // Budget-blocked channels sit outside this test entirely: with all of them
  // blocked the set is empty and the run is healthy, while a real scoring
  // failure alongside one still fails the run.
  //
  // Queue-full channels are excluded for the same reason they are excluded
  // from totalSources above: they never reached scoring, so they can carry no
  // scoringError — and left in, ONE of them made `every` false and swallowed a
  // genuine scoring outage on every other channel, exiting 0.
  const spendable = results.filter((r) => !budgetBlocked.has(r.channel) && r.skipped === undefined)
  if (spendable.length > 0 && spendable.every((r) => r.scoringError !== undefined)) {
    // The count is of the channels the test actually ranged over, with any
    // budget-blocked ones named separately rather than folded into a total
    // that would overstate how many hit a real error.
    const note = budgetBlocked.size > 0 ? ` (${budgetBlocked.size} more budget-blocked)` : ''
    throw new AllChannelsScoringFailedError(
      `all ${spendable.length} scouted channel(s) failed in scoring${note}`,
      results,
    )
  }
  return results
}
