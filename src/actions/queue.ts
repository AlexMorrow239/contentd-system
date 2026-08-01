import type { Database } from 'better-sqlite3'
import { classify, errorMessage } from '../errors.js'
import { ACTIONS, type ActionKind, type ActionLane } from './catalog.js'

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
}

const COLUMNS = `id, kind, lane, args, status, requested_by AS requestedBy,
  created_at AS createdAt, started_at AS startedAt, finished_at AS finishedAt,
  result, error, error_kind AS errorKind, notice`

/**
 * The lane is read from the catalog, never from the caller: the lane decides
 * which worker executes the action, so letting an HTTP request name it would
 * let a form put a Remotion render on the 1-second fast poll.
 */
export function enqueueAction(
  db: Database,
  opts: { kind: ActionKind; args: unknown; requestedBy: string },
): number {
  const info = db
    .prepare(
      'INSERT INTO operator_actions (kind, lane, args, status, requested_by) VALUES (?, ?, ?, ?, ?)',
    )
    .run(opts.kind, ACTIONS[opts.kind].lane, JSON.stringify(opts.args), 'pending', opts.requestedBy)
  return Number(info.lastInsertRowid)
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
export function startAction(db: Database, id: number, now: Date): boolean {
  return (
    db
      .prepare(
        "UPDATE operator_actions SET status = 'running', started_at = ?, notice = NULL WHERE id = ? AND status = 'pending'",
      )
      .run(now.toISOString(), id).changes === 1
  )
}

export function completeAction(db: Database, id: number, result: unknown, now: Date): void {
  db.prepare(
    "UPDATE operator_actions SET status = 'done', result = ?, finished_at = ?, notice = NULL WHERE id = ?",
  ).run(JSON.stringify(result ?? null), now.toISOString(), id)
}

export function failAction(db: Database, id: number, err: unknown, now: Date): void {
  db.prepare(
    "UPDATE operator_actions SET status = 'failed', error = ?, error_kind = ?, finished_at = ?, notice = NULL WHERE id = ?",
  ).run(errorMessage(err), classify(err).kind, now.toISOString(), id)
}

/** Publishes something the operator must act on while the action still runs. */
export function setActionNotice(db: Database, id: number, notice: string | null): void {
  db.prepare('UPDATE operator_actions SET notice = ? WHERE id = ?').run(notice, id)
}

export function getAction(db: Database, id: number): ActionRow | null {
  const row = db.prepare(`SELECT ${COLUMNS} FROM operator_actions WHERE id = ?`).get(id) as
    | ActionRow
    | undefined
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
           error_kind = 'internal', finished_at = ?, notice = NULL
       WHERE lane = ? AND status = 'running'`,
    )
    .run(now.toISOString(), lane).changes
}
