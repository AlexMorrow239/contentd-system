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
 */
export function migrate(db: Database): void {
  if (!hasColumn(db, 'oauth_tokens', 'expires_at')) {
    db.exec('ALTER TABLE oauth_tokens ADD COLUMN expires_at TEXT')
  }
  if (publishesHasOldCheck(db)) {
    // Table rebuild: SQLite cannot drop or widen a CHECK constraint in place.
    // AUTOINCREMENT's id-reuse guarantee survives this — SQLite tracks the
    // largest ROWID ever inserted into a table (sqlite_sequence), not just
    // the largest auto-generated one, so copying explicit `id` values via
    // INSERT...SELECT still advances it correctly (verified by the
    // never-reuses-an-id test).
    db.exec(`
      BEGIN IMMEDIATE;
      CREATE TABLE publishes_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        job_id TEXT NOT NULL REFERENCES jobs(id),
        platform TEXT NOT NULL,
        channel TEXT NOT NULL,
        day TEXT NOT NULL,
        slot TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('claimed','done','failed','interrupted')),
        post_id TEXT, url TEXT, error TEXT,
        error_kind TEXT CHECK (error_kind IN ('auth','quota','rejected','transient')),
        attempt INTEGER NOT NULL,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        finished_at TEXT,
        UNIQUE (channel, platform, day, slot)
      );
      INSERT INTO publishes_new (${PUBLISHES_COLUMNS})
        SELECT ${PUBLISHES_COLUMNS} FROM publishes;
      DROP TABLE publishes;
      ALTER TABLE publishes_new RENAME TO publishes;
      COMMIT;
    `)
  }
}
