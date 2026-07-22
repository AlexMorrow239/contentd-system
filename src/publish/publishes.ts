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
