import type { Database } from 'better-sqlite3'
import BetterSqlite3 from 'better-sqlite3'
import { mkdirSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { migrate } from './migrate.js'

const schemaPath = fileURLToPath(new URL('./schema.sql', import.meta.url))
// Read once per process: the file cannot change under a running process, and
// the test suite opens hundreds of databases. The per-open `exec` below is the
// deliberate part, not this read.
const SCHEMA_SQL = readFileSync(schemaPath, 'utf8')

export function openDb(dbPath: string): Database {
  mkdirSync(dirname(dbPath), { recursive: true })
  const db = new BetterSqlite3(dbPath)
  db.pragma('journal_mode = WAL')
  // Cron runs scout and produce-next as SEPARATE processes against this one
  // file (co-fired 3x/day). A writer holds its lock for milliseconds, so a
  // 5s timeout makes an overlapping write wait the lock out instead of
  // throwing SQLITE_BUSY and crashing a run mid-flight. Set explicitly rather
  // than relying on the better-sqlite3 library default staying 5000.
  db.pragma('busy_timeout = 5000')
  // better-sqlite3 v12+ enables foreign_keys by default; this project keeps
  // FK enforcement OFF by design (schema documents relationships, app code
  // owns integrity; tests insert child rows standalone).
  db.pragma('foreign_keys = OFF')
  db.exec(SCHEMA_SQL)
  migrate(db)
  return db
}
