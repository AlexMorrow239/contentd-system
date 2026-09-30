import type { Database } from 'better-sqlite3'
import { classify, errorMessage } from '../errors.js'
import { ownsLease, type LeaseContext } from '../loop/lease.js'
import { ACTIONS, type ActionKind, type ActionLane } from './catalog.js'
import { resolveTime, systemTime, type TimeSource } from '../time.js'

export type ActionStatus = 'pending' | 'running' | 'done' | 'failed'

export interface ActionRow {
  id: number
  kind: string
  lane: ActionLane
  args: string
  status: ActionStatus
  requestedBy: string
  createdAt: string
  startedAt: string | null
  finishedAt: string | null
  result: string | null
  error: string | null
  errorKind: string | null
  notice: string | null
  ownerToken: string | null
  jobId: string | null
}

const COLUMNS = `id, kind, lane, args, status, requested_by AS requestedBy,
  created_at AS createdAt, started_at AS startedAt, finished_at AS finishedAt,
  result, error, error_kind AS errorKind, notice, owner_token AS ownerToken, job_id AS jobId`

/**
 * The lane is read from the catalog, never from the caller: the lane decides
 * which worker executes the action, so letting an HTTP request name it would
 * let a form put a Remotion render on the 1-second fast poll.
 */
export function enqueueAction(
  db: Database,
  opts: { kind: ActionKind; args: unknown; requestedBy: string; time?: TimeSource },
): number {
  return db
    .transaction(() => {
      // Serialize lookup + insert so concurrent submissions share one resume.
      const args = JSON.stringify(opts.args)
      if (opts.kind === 'jobs.resume') {
        const existing = db
          .prepare(
            `SELECT id FROM operator_actions
             WHERE kind = 'jobs.resume' AND status IN ('pending', 'running')
               AND json_extract(CASE WHEN json_valid(args) THEN args END, '$.jobId') = json_extract(?, '$.jobId')
             ORDER BY id LIMIT 1`,
          )
          .get(args) as { id: number } | undefined
        if (existing) return existing.id
      }
      const info = db
        .prepare(
          'INSERT INTO operator_actions (kind, lane, args, status, requested_by, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        )
        .run(
          opts.kind,
          ACTIONS[opts.kind].lane,
          args,
          'pending',
          opts.requestedBy,
          (opts.time ?? systemTime).now().toISOString(),
        )
      return Number(info.lastInsertRowid)
    })
    .immediate()
}

export function pendingActions(db: Database, lane: ActionLane, limit: number): ActionRow[] {
  return db
    .prepare(
      `SELECT ${COLUMNS} FROM operator_actions
       WHERE lane = ? AND status = 'pending' ORDER BY id ASC LIMIT ?`,
    )
    .all(lane, limit) as ActionRow[]
}

/**
 * Claim. The `status = 'pending'` guard IS the claim — a losing caller sees
 * `changes === 0` rather than double-running the action — so no explicit
 * transaction is needed for the two lane workers to share this table safely.
 */
export function startAction(db: Database, id: number, now: Date, owner?: LeaseContext): boolean {
  owner?.assertOwned()
  return (
    db
      .prepare(
        "UPDATE operator_actions SET status = 'running', started_at = ?, owner_token = ?, notice = NULL, error = NULL, error_kind = NULL, result = NULL, finished_at = NULL WHERE id = ? AND status = 'pending'",
      )
      .run(now.toISOString(), owner?.token ?? null, id).changes === 1
  )
}

export function completeAction(
  db: Database,
  id: number,
  result: unknown,
  now: Date,
  owner?: LeaseContext,
): void {
  owner?.assertOwned()
  db.prepare(
    "UPDATE operator_actions SET status = 'done', result = ?, finished_at = ?, notice = NULL WHERE id = ? AND status = 'running' AND owner_token IS ?",
  ).run(JSON.stringify(result ?? null), now.toISOString(), id, owner?.token ?? null)
}

export function failAction(
  db: Database,
  id: number,
  err: unknown,
  now: Date,
  owner?: LeaseContext,
): void {
  owner?.assertOwned()
  db.prepare(
    "UPDATE operator_actions SET status = 'failed', error = ?, error_kind = ?, finished_at = ? WHERE id = ? AND status = 'running' AND owner_token IS ?",
  ).run(errorMessage(err), classify(err).kind, now.toISOString(), id, owner?.token ?? null)
}

/**
 * Publishes an interactive status for the row to show the operator: the
 * worker's lease-blocked path writes here while a row is still `pending`, and
 * a running handler writes here through `ActionContext.setNotice`
 * (`jobs.produce` records its job id).
 *
 * `startAction` and `completeAction` clear it; the two FAILURE transitions
 * deliberately do NOT. A killed `jobs.produce` must stay traceable to the job
 * it created, and on a failure the notice is exactly the context wanted.
 */
export function setActionNotice(db: Database, id: number, notice: string | null): void {
  db.prepare('UPDATE operator_actions SET notice = ? WHERE id = ?').run(notice, id)
}

export function getAction(db: Database, id: number): ActionRow | null {
  const row = db.prepare(`SELECT ${COLUMNS} FROM operator_actions WHERE id = ?`).get(id) as
    ActionRow | undefined
  return row ?? null
}

export function listRecentActions(db: Database, limit: number): ActionRow[] {
  return db
    .prepare(`SELECT ${COLUMNS} FROM operator_actions ORDER BY id DESC LIMIT ?`)
    .all(limit) as ActionRow[]
}

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
