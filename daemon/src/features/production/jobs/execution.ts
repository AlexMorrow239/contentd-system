import type { Database } from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import { LeaseLostError, ownsLease, type LeaseContext } from '../../../infra/coordination/lease.js'
import { ContentdError } from '../../../shared/errors.js'

export function beginAttempt(db: Database, jobId: string, lease: LeaseContext): string {
  return db
    .transaction(() => {
      lease.assertOwned()
      if (lease.name !== 'produce') throw new LeaseLostError('produce')
      const job = db
        .prepare('SELECT status, active_attempt_id FROM jobs WHERE id=? AND deleted_at IS NULL')
        .get(jobId) as { status: string; active_attempt_id: string | null } | undefined
      if (!job) throw new Error(`job not found: ${jobId}`)
      if (job.status === 'done')
        throw new ContentdError(`job ${jobId} is already done`, { domain: 'job', kind: 'refused' })
      if (job.active_attempt_id !== null) {
        const attempt = db
          .prepare('SELECT owner_token FROM execution_attempts WHERE id=? AND status=?')
          .get(job.active_attempt_id, 'running') as { owner_token: string } | undefined
        if (attempt && ownsLease(db, 'produce', attempt.owner_token, lease.time))
          throw new ContentdError(`job ${jobId} already has a live attempt`, {
            domain: 'job',
            kind: 'conflict',
          })
      }
      const id = randomUUID()
      db.prepare(
        'INSERT INTO execution_attempts (id,job_id,owner_token,status,started_at) VALUES (?,?,?,?,?)',
      ).run(id, jobId, lease.token, 'running', lease.time.now().toISOString())
      db.prepare(
        "UPDATE jobs SET status='running',active_attempt_id=?,finished_at=NULL,recovery_pending=0 WHERE id=?",
      ).run(id, jobId)
      return id
    })
    .immediate()
}

/** Must be called inside the same transaction as the state change it protects. */
export function assertAttempt(
  db: Database,
  jobId: string,
  attemptId: string,
  lease: LeaseContext,
): void {
  lease.assertOwned()
  if (
    !db
      .prepare("SELECT 1 FROM jobs WHERE id=? AND active_attempt_id=? AND status='running'")
      .get(jobId, attemptId)
  )
    throw new LeaseLostError('produce')
}

export function reconcileJobs(db: Database, lease: LeaseContext): number {
  const now = lease.time.now()
  return db
    .transaction(() => {
      lease.assertOwned()
      if (lease.name !== 'produce') throw new LeaseLostError('produce')
      const jobs = db
        .prepare(
          `SELECT j.id,j.active_attempt_id,j.recovery_count,a.owner_token
      FROM jobs j LEFT JOIN execution_attempts a ON a.id=j.active_attempt_id
      WHERE j.deleted_at IS NULL AND j.status IN ('queued','running') AND j.recovery_pending=0`,
        )
        .all() as {
        id: string
        active_attempt_id: string | null
        recovery_count: number
        owner_token: string | null
      }[]
      let recovered = 0
      for (const job of jobs) {
        if (job.owner_token && ownsLease(db, 'produce', job.owner_token, lease.time)) continue
        const stage = db
          .prepare(
            "SELECT stage FROM job_stages WHERE job_id=? AND status='running' ORDER BY rowid LIMIT 1",
          )
          .get(job.id) as { stage: string } | undefined
        const count = job.recovery_count + 1
        const delay = Math.min(30_000 * 2 ** Math.min(count - 1, 6), 1_800_000)
        db.prepare(
          "UPDATE execution_attempts SET status='interrupted',finished_at=? WHERE id=? AND status='running'",
        ).run(now.toISOString(), job.active_attempt_id)
        db.prepare(
          `UPDATE jobs SET status='queued',active_attempt_id=NULL,previous_attempt_id=?,recovery_pending=1,
        recovery_count=?,recovery_stage=?,retry_after=?,finished_at=NULL WHERE id=?`,
        ).run(
          job.active_attempt_id,
          count,
          stage?.stage ?? null,
          new Date(now.getTime() + delay).toISOString(),
          job.id,
        )
        // Incomplete files stay with the interrupted attempt. Only done checkpoints survive.
        db.prepare(
          "UPDATE job_stages SET status='pending',error='interrupted; automatic recovery scheduled' WHERE job_id=? AND status='running'",
        ).run(job.id)
        recovered++
      }
      return recovered
    })
    .immediate()
}

export function linkActionJob(
  db: Database,
  actionId: number | undefined,
  jobId: string,
  owner?: LeaseContext,
): void {
  if (actionId === undefined) return
  owner?.assertOwned()
  const changed = db
    .prepare(
      "UPDATE operator_actions SET job_id=? WHERE id=? AND status='running' AND (owner_token IS ?)",
    )
    .run(jobId, actionId, owner?.token ?? null).changes
  if (changed !== 1) throw new LeaseLostError('daemon')
}
