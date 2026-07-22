import type { Database } from 'better-sqlite3'
import BetterSqlite3 from 'better-sqlite3'
import type { Platform, PublishErrorKind } from './types.js'

export type PublishStatus = 'claimed' | 'done' | 'failed' | 'interrupted'

export interface PublishRow {
  id: number
  jobId: string
  platform: Platform
  channel: string
  day: string
  slot: string
  status: PublishStatus
  postId: string | null
  url: string | null
  error: string | null
  errorKind: PublishErrorKind | null
  attempt: number
  createdAt: string
  finishedAt: string | null
}

// Attempt cap for the eligibility pool (design spec decision 8): a job with
// this many 'rejected'-kind failures retires from rotation and is
// digest-flagged — auth/quota/transient failures never count toward it.
export const MAX_PUBLISH_ATTEMPTS = 3

// INSERT a claimed row; attempt = 1 + count of every prior row for this
// (jobId, platform), computed inside the same transaction so a concurrent
// claim can never observe a half-written count. The UNIQUE (channel,
// platform, day, slot) constraint IS the slot bookkeeping (design spec
// §3.1) — a conflict here means a racing tick already took the slot, so
// the SqliteError from the INSERT (and only the INSERT) is caught and
// reported as null rather than propagated.
export function claimPublish(
  db: Database,
  opts: { jobId: string; platform: Platform; channel: string; day: string; slot: string },
): number | null {
  const countPriorAttempts = db.prepare(
    'SELECT COUNT(*) AS n FROM publishes WHERE job_id = ? AND platform = ?',
  )
  const insertClaim = db.prepare(
    "INSERT INTO publishes (job_id, platform, channel, day, slot, status, attempt) " +
      "VALUES (?, ?, ?, ?, ?, 'claimed', ?)",
  )
  const claim = db.transaction((): number | null => {
    const { n } = countPriorAttempts.get(opts.jobId, opts.platform) as { n: number }
    try {
      const info = insertClaim.run(
        opts.jobId,
        opts.platform,
        opts.channel,
        opts.day,
        opts.slot,
        n + 1,
      )
      return Number(info.lastInsertRowid)
    } catch (err) {
      if (err instanceof BetterSqlite3.SqliteError && err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
        return null
      }
      throw err
    }
  })
  return claim()
}

// ONE transaction: the publishes row flips to done with its post facts, AND
// the library row flips to 'published' — no window where one fact is
// visible without the other (design spec §6 step 9). A missing id is a
// silent no-op (defensive; the tick only ever calls this with an id it
// just claimed).
export function markPublishDone(
  db: Database,
  id: number,
  postId: string,
  url: string,
  now: Date,
): void {
  const selectJobId = db.prepare('SELECT job_id FROM publishes WHERE id = ?')
  const updatePublish = db.prepare(
    "UPDATE publishes SET status = 'done', post_id = ?, url = ?, finished_at = ? WHERE id = ?",
  )
  const updateLibrary = db.prepare("UPDATE library SET state = 'published' WHERE job_id = ?")
  db.transaction(() => {
    const row = selectJobId.get(id) as { job_id: string } | undefined
    if (row === undefined) return
    updatePublish.run(postId, url, now.toISOString(), id)
    updateLibrary.run(row.job_id)
  })()
}

// Failure never touches the library row: the video stays 'ready' and
// re-enters the eligibility pool for the next slot (design spec decision 7).
export function markPublishFailed(
  db: Database,
  id: number,
  error: string,
  kind: PublishErrorKind,
  now: Date,
): void {
  db.prepare(
    "UPDATE publishes SET status = 'failed', error = ?, error_kind = ?, finished_at = ? WHERE id = ?",
  ).run(error, kind, now.toISOString(), id)
}

// Repair sweep for a tick that died mid-upload (design spec decision 12):
// claimed rows older than the TTL are stale — flip to 'interrupted' so
// they never look like an active claim to a later tick. Guarded by
// status, so a rerun against the same cutoff finds nothing left to flip.
export function sweepInterrupted(db: Database, olderThanMs: number, now: Date): number {
  const cutoff = new Date(now.getTime() - olderThanMs).toISOString()
  const info = db
    .prepare(
      "UPDATE publishes SET status = 'interrupted' WHERE status = 'claimed' AND created_at <= ?",
    )
    .run(cutoff)
  return info.changes
}

// Slot bookkeeping read: every slot string with a row of ANY status for
// this (channel, platform, day) — an attempt, successful or not, consumes
// its slot for the rest of the local day (design spec decision 7).
export function consumedSlots(
  db: Database,
  channel: string,
  platform: Platform,
  day: string,
): Set<string> {
  const rows = db
    .prepare('SELECT slot FROM publishes WHERE channel = ? AND platform = ? AND day = ?')
    .all(channel, platform, day) as { slot: string }[]
  return new Set(rows.map((r) => r.slot))
}

// Platform quota gate (design spec decision 10, §6 step 4): every row that
// plausibly reached videos.insert today — claimed/done/interrupted, plus
// failed rows whose error_kind isn't 'auth' (an auth rejection never
// reaches the upload call, so it never burns quota; NULL error_kind is a
// non-auth failure and still counts). `IS NOT` (not `!=`) so a NULL
// error_kind compares as non-auth instead of making the whole clause
// unknown.
export function uploadsUsedToday(db: Database, platform: Platform, day: string): number {
  const row = db
    .prepare(
      "SELECT COUNT(*) AS n FROM publishes WHERE platform = ? AND day = ? " +
        "AND (status != 'failed' OR error_kind IS NOT 'auth')",
    )
    .get(platform, day) as { n: number }
  return row.n
}

// Eligibility per design spec §6 step 6: 'ready' library rows for jobs on
// this channel, excluding any job that already has a done/claimed/
// interrupted row for this platform (it's either published or in
// flight), and excluding any job at or past MAX_PUBLISH_ATTEMPTS
// 'rejected' failures (poison-video guard — decision 8; only 'rejected'
// counts, since auth/quota/transient failures are channel- or
// platform-wide, not the video's fault). The LEFT JOIN is against a
// per-job aggregate (grouped by job_id, filtered to this platform) rather
// than a raw join against `publishes`, so a job with several rows
// contributes exactly one joined row — no fan-out to dedupe. Order:
// fewest failed rows of any kind first (spreads attempts during a
// channel-wide outage), then newest library row first (fresh trend
// content over stale), then job id for determinism.
export function eligibleVideo(
  db: Database,
  channel: string,
  platform: Platform,
): { jobId: string; videoPath: string; metadataJson: string; topic: string } | null {
  const row = db
    .prepare(
      `SELECT l.job_id AS jobId, l.video_path AS videoPath, l.metadata_json AS metadataJson, j.topic AS topic
       FROM library l
       JOIN jobs j ON j.id = l.job_id
       LEFT JOIN (
         SELECT job_id,
                SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failedCount,
                SUM(CASE WHEN status = 'failed' AND error_kind = 'rejected' THEN 1 ELSE 0 END) AS rejectedCount,
                SUM(CASE WHEN status IN ('done','claimed','interrupted') THEN 1 ELSE 0 END) AS blockingCount
         FROM publishes
         WHERE platform = ?
         GROUP BY job_id
       ) p ON p.job_id = l.job_id
       WHERE l.state = 'ready'
         AND j.channel = ?
         AND COALESCE(p.blockingCount, 0) = 0
         AND COALESCE(p.rejectedCount, 0) < ?
       ORDER BY COALESCE(p.failedCount, 0) ASC, l.created_at DESC, l.job_id ASC
       LIMIT 1`,
    )
    .get(platform, channel, MAX_PUBLISH_ATTEMPTS) as
    | { jobId: string; videoPath: string; metadataJson: string; topic: string }
    | undefined
  return row === undefined ? null : row
}
