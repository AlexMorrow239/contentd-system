import type { Database } from 'better-sqlite3'
import { BrainrotError } from '../errors.js'
import type { TimeSource } from '../time.js'

/** Keep the job and its ledger for budget/quota accounting, but retire its work. */
export function deleteJob(db: Database, jobId: string, time: TimeSource): boolean {
  return db
    .transaction(() => {
      const job = db.prepare('SELECT status, deleted_at FROM jobs WHERE id = ?').get(jobId) as
        { status: string; deleted_at: string | null } | undefined
      if (!job || job.deleted_at !== null) return false
      if (job.status === 'running') {
        throw new BrainrotError(`job ${jobId} is running; wait until it finishes before deleting`, {
          domain: 'job',
          kind: 'conflict',
        })
      }
      db.prepare(
        'UPDATE jobs SET deleted_at = ?, recovery_pending = 0, retry_after = NULL WHERE id = ?',
      ).run(time.now().toISOString(), jobId)
      db.prepare('DELETE FROM library WHERE job_id = ?').run(jobId)
      db.prepare('DELETE FROM posts WHERE job_id = ?').run(jobId)
      // Do not feed a deleted job straight back into automatic production.
      db.prepare(
        "UPDATE topics SET status = CASE WHEN status = 'claimed' THEN 'rejected' ELSE status END, job_id = NULL WHERE job_id = ?",
      ).run(jobId)
      return true
    })
    .immediate()
}
