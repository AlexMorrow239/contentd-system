import type { Database } from 'better-sqlite3'
import { MAX_PUBLISH_ATTEMPTS } from './publishes.js'
import type { Platform } from './types.js'

// pendingInventory (jobs/library.ts) and reclaimableObjects (posts/reclaim.ts)
// no longer use this module — under manual posting, "unconsumed" is a plain
// row-existence count over `posts`, with no age clause. This file survives
// only because src/loop/digest.ts's attempt-capped/aged-out reporting still
// reads it, which in turn depends on the `publishes` table that a later task
// migrates and drops. Its own test file (test/settled.test.ts) was deleted
// with that task's reclaim/pendingInventory rewrite, since it pinned exactly
// the behavior removed here — this module is intentionally uncovered until
// digest.ts's dependency on it is retired too.

/**
 * One (video, platform) leg's publish history, reduced to the three counts
 * the settled predicate needs. A leg with no history at all is represented by
 * the ABSENCE of an entry, not by a zeroed one — "never attempted" and
 * "attempted and failed transiently" settle identically, but the distinction
 * costs nothing to preserve and reads clearly at the call sites.
 */
export interface LegFacts {
  platform: Platform
  doneCount: number
  /** claimed | interrupted — in flight, or an unresolved outcome. */
  pendingCount: number
  /** 'failed' rows with error_kind 'rejected' — the poison-video counter. */
  rejectedCount: number
}

/**
 * The instant a video must predate to count as aged out, rendered in the same
 * format `library.created_at` is stored in (`strftime('%Y-%m-%dT%H:%M:%fZ')`,
 * which is exactly `Date#toISOString`). Returned as a string so callers can
 * bind it straight into SQL as a lexicographic comparison — the format is
 * fixed-width and zero-padded, so string order IS chronological order.
 */
export function agedCutoff(now: Date, backlogDays: number): string {
  return new Date(now.getTime() - backlogDays * 86_400_000).toISOString()
}

/**
 * The channel-wide evidence that ageing out is a real outcome and not just a
 * stopped clock: the newest 'done' publish per job that landed AT OR BEFORE
 * the aged-out horizon, newest first, at most two rows.
 *
 * The `cutoff` restriction is the whole point of the shape and is carried on
 * the facts so no caller can pair a read with a different horizon than the one
 * it asks isAged about. Contention has to fall inside the video's own grace
 * window — see isAged — and the newest done row OVERALL is the wrong thing to
 * hold: one publish after the window closed would otherwise re-arm the horizon
 * for every older video at once.
 *
 * Two rows is exactly enough. The question asked of these facts is "did some
 * OTHER job of this channel publish inside this video's window" — so only the
 * newest qualifying done publish belonging to a different job can ever answer
 * it. Grouping by job_id makes each row a distinct job, so the top row answers
 * unless it is the video's own job, in which case the second row does.
 * Everything below them is dominated.
 *
 * One read per channel, not per video — the same discipline legFactsByJob
 * follows.
 */
export interface ContentionFacts {
  /** The horizon this read was taken against; isAged compares videos to it. */
  readonly cutoff: string
  /** (job, newest done publish at-or-before `cutoff`) pairs, newest first. At most two. */
  readonly recentDone: readonly { jobId: string; at: string }[]
}

export function contentionFacts(db: Database, channel: string, cutoff: string): ContentionFacts {
  const recentDone = db
    .prepare(
      `SELECT job_id AS jobId, MAX(created_at) AS at
       FROM publishes WHERE channel = ? AND status = 'done' AND created_at <= ?
       GROUP BY job_id ORDER BY at DESC, job_id ASC LIMIT 2`,
    )
    .all(channel, cutoff) as { jobId: string; at: string }[]
  return { cutoff, recentDone }
}

/**
 * Has this video aged out — i.e. is it old enough to write off, AND did
 * something actually outrank it WHILE IT WAS WAITING?
 *
 * The age clause's whole justification is contention: newer videos took the
 * scarce platform's slots ahead of this one, permanently. That argument needs
 * newer videos to have actually published, and to have published during this
 * video's grace window — the span between its own creation and the horizon.
 *
 * Both halves of that window matter:
 *
 *   - Without any contention test, a publish outage longer than backlog_days
 *     (host down, expired credential) would make the first recovering tick
 *     declare EVERY stored video aged out — deleting the bytes of videos
 *     nothing ever outranked, and simultaneously refusing to publish them.
 *   - Without the `<= cutoff` upper bound, ONE publish after the outage ends
 *     re-arms the horizon for the whole backlog at once: 10 stranded videos,
 *     the newest gets published on the first recovering tick, and on the next
 *     tick that single done row is "newer than" the other nine, ageing all
 *     nine out together. The outage's damage would be deferred by one tick,
 *     not prevented. A publish that happens after the window closed is not
 *     evidence that this video was passed over while it waited.
 *
 * `facts.recentDone` is already restricted to `<= facts.cutoff` by the read,
 * so the check here is the lower bound alone. Every comparison is
 * lexicographic on the same fixed-width ISO-8601 UTC format, so string order
 * IS chronological order.
 */
export function isAged(
  facts: ContentionFacts,
  video: { jobId: string; createdAt: string },
): boolean {
  if (video.createdAt >= facts.cutoff) return false
  return facts.recentDone.some((r) => r.jobId !== video.jobId && r.at > video.createdAt)
}

/**
 * Is this (video, platform) leg settled — i.e. can this platform never take
 * this video again?
 *
 * Three ways to settle:
 *   - the platform published it (`doneCount > 0`);
 *   - the platform is attempt-capped (MAX_PUBLISH_ATTEMPTS 'rejected'
 *     failures — the same poison-video guard channelVideoCandidates applies);
 *   - the video aged out with no live row (`aged`, which means aged AND
 *     contended — see isAged below; never the bare date comparison).
 *
 * The third clause is the one that makes the design correct, because PASSED
 * OVER is a real outcome distinct from failed. A channel publishing 10 videos
 * a day to both platforms hits YouTube's ~6/day project-wide cap: 4 videos get
 * their Instagram leg and never their YouTube one. channelVideoCandidates
 * orders created_at DESC, so tomorrow's fresh videos outrank them for
 * YouTube's 6 slots, permanently. Nothing is ever written to `publishes` for
 * those legs — so without the age clause they are never done, never failed,
 * and never settled: their objects would live forever and, worse, they would
 * count as inventory forever, tripping the production gate within days and
 * halting the channel outright.
 *
 * A pending row (claimed/interrupted) NEVER settles, at any age. 'interrupted'
 * means the upload's outcome is unknown — the post may be live — so the bytes
 * must survive until an operator resolves it with `publish mark-done` or
 * `publish retry`.
 *
 * Nothing here writes a `publishes` row for an aged-out leg. That table
 * records what actually went out; fabricating a row for an upload that never
 * happened would be a lie in the one place that must not hold one.
 */
export function isLegSettled(facts: LegFacts | undefined, aged: boolean): boolean {
  if (facts === undefined) return aged
  if (facts.pendingCount > 0) return false
  if (facts.doneCount > 0) return true
  if (facts.rejectedCount >= MAX_PUBLISH_ATTEMPTS) return true
  return aged
}

/**
 * Is every platform this channel declares settled for this video?
 *
 * `declared` is the channel's target list as plain data (never a
 * ChannelConfig — this module stays config-free, like the publishes DAO).
 * Legs for undeclared platforms are ignored: a channel that dropped Instagram
 * from its TOML is not waiting on Instagram.
 *
 * An empty `declared` is false, not vacuously true: a channel with no
 * [publish] table publishes nothing, so nothing about its videos is settled
 * by publishing. Its inventory drains by `library reject`, and its objects are
 * reclaimed by that path's existing delete.
 */
export function isFullySettled(opts: {
  declared: readonly Platform[]
  legs: readonly LegFacts[]
  aged: boolean
}): boolean {
  if (opts.declared.length === 0) return false
  const byPlatform = new Map(opts.legs.map((l) => [l.platform, l]))
  return opts.declared.every((p) => isLegSettled(byPlatform.get(p), opts.aged))
}

interface DbLegRow {
  job_id: string
  platform: Platform
  doneCount: number
  pendingCount: number
  rejectedCount: number
}

/**
 * Every leg's facts for the given jobs, in ONE grouped read rather than a
 * query per video — the same shape channelVideoCandidates already uses for its
 * blocking facts. Jobs with no publishes rows are absent from the map; callers
 * read that as "no leg has any history", which `isLegSettled(undefined, …)`
 * handles.
 */
export function legFactsByJob(
  db: Database,
  jobIds: readonly string[],
): Map<string, LegFacts[]> {
  const byJob = new Map<string, LegFacts[]>()
  if (jobIds.length === 0) return byJob
  const placeholders = jobIds.map(() => '?').join(', ')
  const rows = db
    .prepare(
      `SELECT job_id, platform,
              SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) AS doneCount,
              SUM(CASE WHEN status IN ('claimed','interrupted') THEN 1 ELSE 0 END) AS pendingCount,
              SUM(CASE WHEN status = 'failed' AND error_kind = 'rejected' THEN 1 ELSE 0 END) AS rejectedCount
       FROM publishes WHERE job_id IN (${placeholders})
       GROUP BY job_id, platform
       ORDER BY job_id, platform`,
    )
    .all(...jobIds) as DbLegRow[]
  for (const row of rows) {
    const legs = byJob.get(row.job_id) ?? []
    legs.push({
      platform: row.platform,
      doneCount: row.doneCount,
      pendingCount: row.pendingCount,
      rejectedCount: row.rejectedCount,
    })
    byJob.set(row.job_id, legs)
  }
  return byJob
}
