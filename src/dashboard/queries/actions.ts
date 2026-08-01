import type { Database } from 'better-sqlite3'
import { listRecentActions, type ActionRow } from '../../actions/queue.js'
import { daemonIsStale, readDaemonState, type DaemonState } from '../../loop/daemon-state.js'

/** One screen's worth of audit history; the table itself is never pruned. */
export const ACTIONS_PAGE_LIMIT = 100

export interface ActionsPageData {
  actions: ActionRow[]
  daemonStale: boolean
  daemonState: DaemonState | null
}

export function buildActionsPage(db: Database, now: Date): ActionsPageData {
  const daemonState = readDaemonState(db)
  return {
    actions: listRecentActions(db, ACTIONS_PAGE_LIMIT),
    daemonStale: daemonIsStale(daemonState, now),
    daemonState,
  }
}

/**
 * Rows still waiting to be picked up by a worker — 'running' is deliberately
 * excluded, since that row already has a worker's attention and is not what
 * an operator means by "pending".
 */
export function pendingActionCount(db: Database): number {
  const row = db
    .prepare("SELECT count(*) AS n FROM operator_actions WHERE status = 'pending'")
    .get() as { n: number }
  return row.n
}

/**
 * openDbReadonly never runs schema.sql, so a dashboard pointed at a database
 * no openDb call has ever touched has no operator_actions table. Probing lets
 * the page disable its controls with an explanation instead of 500-ing — the
 * same deploy-order trap `body_text` and `target_url` already have, and the
 * first one to affect a write path.
 */
export function actionsTableExists(db: Database): boolean {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'operator_actions'")
    .get() as { name: string } | undefined
  return row !== undefined
}
