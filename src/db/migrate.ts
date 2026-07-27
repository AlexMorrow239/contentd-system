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
  'id, job_id, platform, channel, day, seq, status, post_id, url, error, error_kind, attempt, created_at, finished_at'

/**
 * Table rebuild for the two publishes changes CREATE TABLE IF NOT EXISTS
 * cannot express against an existing database: SQLite can neither widen a
 * CHECK constraint nor retype a column in place.
 *
 * One branch, not two, because every database carrying the old
 * `platform IN ('youtube')` CHECK also has the `slot` column — the CHECK
 * predates the seq migration, so a database old enough to still have it is
 * necessarily old enough to have `slot` too. The slot->seq mapping therefore
 * subsumes the old CHECK's rebuild unconditionally, and because the rebuild
 * replays schema.sql, it fixes the CHECK as a side effect regardless of which
 * predicate triggered the call.
 *
 * Renaming the old table out of the way lets schema.sql's own CREATE TABLE IF
 * NOT EXISTS rebuild `publishes` at its current shape; every other statement
 * in the file is a no-op against the tables already here.
 *
 * AUTOINCREMENT's id-reuse guarantee survives this — SQLite tracks the
 * largest ROWID ever inserted into a table (sqlite_sequence), not just the
 * largest auto-generated one, so copying explicit `id` values via
 * INSERT...SELECT still advances it correctly (verified by the
 * never-reuses-an-id test).
 */
function rebuildPublishes(db: Database, schemaSql: string): void {
  // Historical rows have clock-time slots, not ordinals. Ranking by slot
  // within each (channel, platform, day) reproduces the order they were
  // actually attempted in; `id` is a tiebreak that the old
  // UNIQUE(channel,platform,day,slot) made unreachable, kept for determinism.
  const copy = `INSERT INTO publishes (${PUBLISHES_COLUMNS})
       SELECT id, job_id, platform, channel, day,
              ROW_NUMBER() OVER (PARTITION BY channel, platform, day ORDER BY slot, id),
              status, post_id, url, error, error_kind, attempt, created_at, finished_at
       FROM publishes_old`
  db.transaction(() => {
    db.exec('ALTER TABLE publishes RENAME TO publishes_old')
    db.exec(schemaSql)
    db.exec(copy)
    db.exec('DROP TABLE publishes_old')
  }).immediate()
}

/**
 * Idempotent post-schema migration for changes CREATE TABLE IF NOT EXISTS
 * cannot express against an existing database: SQLite cannot ALTER a CHECK
 * constraint or retype a column, and ADD COLUMN is not part of schema.sql's
 * declarative form. Every step inspects state before acting, so re-running is
 * a no-op. Called by openDb only — never by openDbReadonly, which must stay
 * write-free.
 *
 * `schemaSql` is the same schema.sql text openDb just exec'd. The rebuild
 * replays it rather than carrying its own copy of the publishes DDL:
 * schema.sql is the single source of truth for table shape, and a second
 * hand-written copy here would silently drift from it the first time a
 * column is added — producing differently-shaped tables on migrated versus
 * freshly-created databases.
 */
export function migrate(db: Database, schemaSql: string): void {
  if (!hasColumn(db, 'oauth_tokens', 'expires_at')) {
    db.exec('ALTER TABLE oauth_tokens ADD COLUMN expires_at TEXT')
  }
  if (hasColumn(db, 'publishes', 'slot') || publishesHasOldCheck(db)) {
    rebuildPublishes(db, schemaSql)
  }
}
