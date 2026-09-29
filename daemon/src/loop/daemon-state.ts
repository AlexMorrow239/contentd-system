import type { Database } from 'better-sqlite3'

/**
 * How often the actions-fast worker stamps its heartbeat. Deliberately far
 * above that worker's ~1s poll: a write every second would churn the WAL for a
 * value nothing reads that often.
 */
export const DAEMON_HEARTBEAT_MS = 10_000

/**
 * How old a heartbeat may be before the dashboard declares the daemon down.
 * Six missed beats — high enough that a slow poll or a long synchronous unit
 * never flaps the banner, low enough that a stopped container is reported
 * within a minute.
 */
export const DAEMON_STALE_MS = 60_000

export interface DaemonState {
  pid: number
  startedAt: string
  lastSeenAt: string
}

/**
 * Heartbeat. `started_at` is preserved across beats from the same pid and
 * reset when a different pid takes the row — that's what lets a reader
 * distinguish a restart (new pid, `started_at` jumps) from a continuation
 * (same pid, `started_at` holds), not currently used to report uptime.
 */
export function stampDaemonSeen(db: Database, pid: number, now: Date): void {
  const iso = now.toISOString()
  db.prepare(
    `INSERT INTO daemon_state (id, pid, started_at, last_seen_at) VALUES (1, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       pid = excluded.pid,
       started_at = CASE WHEN daemon_state.pid = excluded.pid
                         THEN daemon_state.started_at ELSE excluded.started_at END,
       last_seen_at = excluded.last_seen_at`,
  ).run(pid, iso, iso)
}

export function readDaemonState(db: Database): DaemonState | null {
  const row = db
    .prepare(
      'SELECT pid, started_at AS startedAt, last_seen_at AS lastSeenAt FROM daemon_state WHERE id = 1',
    )
    .get() as DaemonState | undefined
  return row ?? null
}

/**
 * A never-stamped database reads as stale, not as live: "no daemon has ever
 * run against this root" and "the daemon stopped" have the same consequence
 * for a queued action, and the banner says the same thing about both.
 */
export function daemonIsStale(state: DaemonState | null, now: Date): boolean {
  if (state === null) return true
  return now.getTime() - new Date(state.lastSeenAt).getTime() > DAEMON_STALE_MS
}
