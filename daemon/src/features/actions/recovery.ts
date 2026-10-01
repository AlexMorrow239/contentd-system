import type { Database } from 'better-sqlite3'
import { ownsLease, type LeaseContext } from '../../infra/coordination/lease.js'
import { resolveTime } from '../../shared/time.js'
import { type ActionLane } from './catalog.js'
import { COLUMNS, getAction } from './queue.js'
import type { ActionRow } from './types.js'

/**
 * Startup repair, called ONCE per worker rather than on a TTL. Within a single
 * daemon process a 'running' row at startup can only have been left by a dead
 * one, so no age threshold has to be guessed — and guessing one would sweep a
 * legitimately long `produce` out from under itself.
 */
export function failRunningActions(db: Database, lane: ActionLane, now: Date): number {
  return db
    .prepare(
      `UPDATE operator_actions
       SET status = 'failed', error = 'interrupted by a daemon restart',
           error_kind = 'internal', finished_at = ?
       WHERE lane = ? AND status = 'running'`,
    )
    .run(now.toISOString(), lane).changes
}

/** Called only after daemon ownership is acquired, before workers start. */
export function reconcileActions(db: Database, owner: LeaseContext): number {
  const now = owner.time.now()
  return db
    .transaction(() => {
      owner.assertOwned()
      const rows = db
        .prepare(`SELECT ${COLUMNS} FROM operator_actions WHERE status='running'`)
        .all() as ActionRow[]
      let count = 0
      for (const row of rows) {
        if (row.ownerToken && ownsLease(db, 'daemon', row.ownerToken, owner.time)) continue
        reconcileActionRow(db, row, now, 'interrupted by a daemon restart')
        count++
      }
      return count
    })
    .immediate()
}

/** The current daemon reconciles its action after a child operation loses ownership.
 * This is independent of the stale operation's result and never mutates its job. */
export function reconcileInterruptedAction(
  db: Database,
  id: number,
  owner: LeaseContext,
  operation: LeaseContext,
): boolean {
  const time = resolveTime(undefined, owner, operation)
  const now = time.now()
  return db
    .transaction(() => {
      owner.assertOwned()
      if (!operation.signal.aborted && ownsLease(db, operation.name, operation.token, time))
        return false
      const row = getAction(db, id)
      if (!row || row.status !== 'running' || row.ownerToken !== owner.token) return false
      reconcileActionRow(db, row, now, 'interrupted after operation ownership was lost')
      return true
    })
    .immediate()
}

function reconcileActionRow(db: Database, row: ActionRow, now: Date, reason: string): void {
  // Old writers had no atomic linkage. Recover only explicit known IDs;
  // absence of a link on those rows is not proof that no job was created.
  if (row.ownerToken === null && row.jobId === null) {
    let legacyId: unknown
    if (row.kind === 'jobs.produce') legacyId = /^job ([A-Za-z0-9_-]+)$/.exec(row.notice ?? '')?.[1]
    if (row.kind === 'jobs.resume') {
      try {
        legacyId = (JSON.parse(row.args) as { jobId?: unknown }).jobId
      } catch {
        /* ambiguous legacy action */
      }
    }
    if (typeof legacyId === 'string' && db.prepare('SELECT 1 FROM jobs WHERE id=?').get(legacyId)) {
      row.jobId = legacyId
      db.prepare('UPDATE operator_actions SET job_id=? WHERE id=?').run(legacyId, row.id)
    }
  }
  const completed = row.jobId
    ? (db
        .prepare(
          "SELECT l.state,l.video_path FROM library l JOIN jobs j ON j.id=l.job_id WHERE j.id=? AND j.status='done'",
        )
        .get(row.jobId) as { state: string; video_path: string } | undefined)
    : undefined
  if (completed) {
    db.prepare(
      "UPDATE operator_actions SET status='done',result=?,finished_at=?,notice=NULL WHERE id=?",
    ).run(
      JSON.stringify({
        jobId: row.jobId,
        status: completed.state,
        videoPath: completed.video_path,
      }),
      now.toISOString(),
      row.id,
    )
  } else if (
    row.jobId === null &&
    row.ownerToken !== null &&
    ['jobs.produce', 'jobs.resume', 'produce.next'].includes(row.kind)
  ) {
    db.prepare(
      "UPDATE operator_actions SET status='pending',owner_token=NULL,started_at=NULL,notice='interrupted before job linkage; queued again' WHERE id=?",
    ).run(row.id)
  } else {
    const ambiguous =
      row.jobId === null &&
      row.ownerToken === null &&
      ['jobs.produce', 'jobs.resume', 'produce.next'].includes(row.kind)
    const notice = row.jobId
      ? `job ${row.jobId}; interrupted; automatic recovery scheduled`
      : ambiguous
        ? 'legacy action has unknown outcome; existing jobs recover independently'
        : row.notice
    db.prepare(
      "UPDATE operator_actions SET status='failed',error=?,error_kind=?,finished_at=?,notice=? WHERE id=?",
    ).run(
      ambiguous ? 'legacy action has unknown outcome; not replayed' : reason,
      ambiguous ? 'unknown-outcome' : 'internal',
      now.toISOString(),
      notice,
      row.id,
    )
  }
}
