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
