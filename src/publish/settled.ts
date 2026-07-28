import type { Database } from 'better-sqlite3'
import { MAX_PUBLISH_ATTEMPTS } from './publishes.js'
import type { Platform } from './types.js'

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
 * Is this (video, platform) leg settled — i.e. can this platform never take
 * this video again?
 *
 * Three ways to settle:
 *   - the platform published it (`doneCount > 0`);
 *   - the platform is attempt-capped (MAX_PUBLISH_ATTEMPTS 'rejected'
 *     failures — the same poison-video guard channelVideoCandidates applies);
 *   - the video aged out with no live row.
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
