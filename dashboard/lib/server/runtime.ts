import { existsSync } from 'node:fs'
import type { Database } from 'better-sqlite3'
import { openDbReadonly } from '../../../daemon/src/db/dashboard.js'
import { daemonIsStale, readDaemonState } from '../../../daemon/src/loop/daemon-state.js'
import { actionsTableExists } from './queries/actions.js'
import { errorMessage } from '../../../daemon/src/errors.js'

export function daemonStaleFor(db: Database, now: Date): boolean {
  return !actionsTableExists(db) || daemonIsStale(readDaemonState(db), now)
}

export function withDashboardDb<T>(dbPath: string, read: (db: Database) => T): T {
  const db = openDbReadonly(dbPath)
  try {
    db.pragma('schema_version')
    return read(db)
  } finally {
    db.close()
  }
}

export function databaseError(dbPath: string, error: unknown): string {
  console.error(`dashboard: database read failed at ${dbPath}`, error)
  return existsSync(dbPath)
    ? `Could not read database at ${dbPath}: ${errorMessage(error)}`
    : `Database missing at ${dbPath}. Start the daemon once against this root to initialize it.`
}
