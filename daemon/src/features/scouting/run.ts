import type Anthropic from '@anthropic-ai/sdk'
import type { Database } from 'better-sqlite3'
import type { ChannelConfig } from '../../config/channel.js'
import { LeaseLostError, type LeaseContext } from '../../infra/coordination/lease.js'
import type { FetchLike } from '../../infra/sources/types.js'
import { ContentdError, classify } from '../../shared/errors.js'
import { resolveTime, type TimeSource } from '../../shared/time.js'
import { emptyChannelResult, scoutChannel } from './channel.js'
import type { ScoutChannelResult } from './types.js'

// Systemic scout failures: the run produced nothing for a reason no single
// channel's isolation can absorb. Both carry the per-channel results so the CLI
// can still print its one JSON line (Global Constraints: JSON even on failure
// outcomes) before exit 1.
export class ScoutRunFailedError extends ContentdError {
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

export async function scoutAll(
  db: Database,
  channels: ChannelConfig[],
  opts: {
    client?: Anthropic
    fetchImpl?: FetchLike
    time?: TimeSource
    force?: boolean
    lease?: LeaseContext
  } = {},
): Promise<ScoutChannelResult[]> {
  opts = { ...opts, time: resolveTime(opts.time, opts.lease) }
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
    // Each subreddit contributes at most one sourceErrors entry.
    const sourceCount = channel.scout.subreddits.length
    // No subreddits → not a scouted channel; manual produce only.
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
      opts.lease?.assertOwned()
      if (err instanceof LeaseLostError) throw err
      // A channel that threw did reach its sources (the gate returns, never
      // throws), so its sources still count.
      totalSources += sourceCount
      // Per-channel isolation: one channel's scoring failure (including the
      // global-day budget gate) must not starve the others.
      const info = classify(err)
      const message = info.message
      if (info.kind === 'budget') budgetBlocked.add(channel.name)
      console.error(`scout: channel "${channel.name}" scoring failed: ${message}`)
      const partial =
        (info.context.partial as ScoutChannelResult | undefined) ?? emptyChannelResult(channel.name)
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
