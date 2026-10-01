import type { Database } from 'better-sqlite3'
import { type LeaseContext } from '../../infra/coordination/lease.js'
import { classify, errorMessage } from '../../shared/errors.js'
import { systemTime, type TimeSource } from '../../shared/time.js'
import { ACTIONS, type ActionKind, type ActionLane } from './catalog.js'
import type { ActionRow } from './types.js'

export const COLUMNS = `id, kind, lane, args, status, requested_by AS requestedBy,
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
