import type { Database } from 'better-sqlite3'

// A substring of the OLD publishes DDL, unique enough to detect the
// pre-migration shape without parsing SQL. sqlite_master.sql stores the
// CREATE TABLE statement verbatim, so this substring check is exact.
const OLD_PUBLISHES_CHECK_MARKER = "platform IN ('youtube')"

interface TableInfoRow {
  name: string
}

function hasColumn(db: Database, table: string, column: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as TableInfoRow[]
  return rows.some((r) => r.name === column)
}

function publishesHasOldCheck(db: Database): boolean {
  const row = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'publishes'")
    .get() as { sql: string } | undefined
  return row !== undefined && row.sql.includes(OLD_PUBLISHES_CHECK_MARKER)
}

const PUBLISHES_COLUMNS =
  'id, job_id, platform, channel, day, slot, status, post_id, url, error, error_kind, attempt, created_at, finished_at'

/**
 * Idempotent post-schema migration for changes CREATE TABLE IF NOT EXISTS
 * cannot express against an existing database: SQLite cannot ALTER a CHECK
 * constraint, and ADD COLUMN is not part of schema.sql's declarative form.
 * Every step inspects state before acting, so re-running is a no-op. Called
 * by openDb only — never by openDbReadonly, which must stay write-free.
 *
 * `schemaSql` is the same schema.sql text openDb just exec'd. The rebuild
 * below replays it rather than carrying its own copy of the publishes DDL:
 * schema.sql is the single source of truth for table shape, and a second
 * hand-written copy here would silently drift from it the first time a
 * column is added — producing differently-shaped tables on migrated versus
 * freshly-created databases.
 */
export function migrate(db: Database, schemaSql: string): void {
  if (!hasColumn(db, 'oauth_tokens', 'expires_at')) {
    db.exec('ALTER TABLE oauth_tokens ADD COLUMN expires_at TEXT')
  }
  if (publishesHasOldCheck(db)) {
    // Table rebuild: SQLite cannot drop or widen a CHECK constraint in place.
    // Renaming the old table out of the way lets schema.sql's own CREATE
    // TABLE IF NOT EXISTS rebuild `publishes` at its current shape; every
    // other statement in the file is a no-op against the tables already here.
    //
    // AUTOINCREMENT's id-reuse guarantee survives this — SQLite tracks the
    // largest ROWID ever inserted into a table (sqlite_sequence), not just
    // the largest auto-generated one, so copying explicit `id` values via
    // INSERT...SELECT still advances it correctly (verified by the
    // never-reuses-an-id test).
    db.transaction(() => {
      db.exec('ALTER TABLE publishes RENAME TO publishes_old')
      db.exec(schemaSql)
      db.exec(
        `INSERT INTO publishes (${PUBLISHES_COLUMNS}) SELECT ${PUBLISHES_COLUMNS} FROM publishes_old`,
      )
      db.exec('DROP TABLE publishes_old')
    }).immediate()
  }
}
