import { mkdirSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import BetterSqlite3 from 'better-sqlite3'
import type { Database } from 'better-sqlite3'
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

/**
 * Read-only handle for viewers (the dashboard). Deliberately NOT openDb:
 * openDb mkdirs its parent and execs schema.sql, and both are writes a
 * readonly connection cannot perform. Skipping schema creation is also the
 * correct behavior for a viewer — pointed at a path that does not exist it
 * must report a missing database, not create an empty one and render zeroes.
 *
 * fileMustExist is redundant with readonly in better-sqlite3 today; it is set
 * explicitly so the guarantee survives a library default changing.
 */
export function openDbReadonly(dbPath: string): Database {
  const db = new BetterSqlite3(dbPath, { readonly: true, fileMustExist: true })
  // Matches openDb: a cron tick holds its write lock for milliseconds, so a
  // reader waits it out rather than throwing SQLITE_BUSY mid-page-render.
  db.pragma('busy_timeout = 5000')
  return db
}

/**
 * The dashboard's ONE write handle. Deliberately not openDb: no mkdir, no
 * schema.sql exec, no migrate — all three are writes a viewer must never
 * perform, and creating the schema from an HTTP request would let a stray
 * browser hit materialize a database at a typo'd root.
 *
 * Its only statement is `INSERT INTO operator_actions`. Every read route keeps
 * openDbReadonly, which is what narrows the dashboard's read-only guarantee to
 * "no read route can mutate, and the whole write path is one insert into one
 * queue table" rather than dropping it.
 */
export function openDbActions(dbPath: string): Database {
  const db = new BetterSqlite3(dbPath, { fileMustExist: true })
  db.pragma('busy_timeout = 5000')
  // Matches openDb: better-sqlite3 v12+ defaults foreign_keys ON, and this
  // project keeps FK enforcement OFF by design. operator_actions declares no
  // REFERENCES today, so nothing breaks without this — set anyway so this
  // handle stays consistent with every other write handle rather than being
  // an exception a future REFERENCES column would silently trip over.
  db.pragma('foreign_keys = OFF')
  return db
}
