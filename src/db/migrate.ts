import type { Database } from 'better-sqlite3'

interface TableInfoRow {
  name: string
}

function hasColumn(db: Database, table: string, column: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as TableInfoRow[]
  return rows.some((r) => r.name === column)
}

// PRAGMA table_info returns an empty list for a missing table rather than
// throwing, so hasColumn cannot distinguish "no such column" from "no such
// table" — and an ADD COLUMN against the latter throws. openDb execs
// schema.sql first so every table exists in production; this keeps a step
// honest when called on a bare handle.
function tableExists(db: Database, table: string): boolean {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(table)
  return row !== undefined
}

/**
 * The publishing pipeline was removed; per-platform posting is now recorded by
 * hand in `posts`. Carries the history worth keeping — the rows that actually
 * went out — and drops the two tables nothing reads any more.
 *
 * Dropping `publishes` is what makes this step self-disabling, so it is
 * idempotent for free and a no-op on a fresh database.
 */
function migratePublishesToPosts(db: Database): void {
  if (tableExists(db, 'publishes')) {
    // OR IGNORE guards the one shape the old schema permitted: two 'done' rows
    // for one (job, platform). ux_publishes_live constrained only LIVE rows,
    // so a retried-then-succeeded leg could leave a second done row behind.
    db.prepare(
      `INSERT OR IGNORE INTO posts (job_id, channel, platform, url, posted_at)
       SELECT job_id, channel, platform, url, created_at
       FROM publishes WHERE status = 'done'
       ORDER BY created_at ASC`,
    ).run()
    db.exec('DROP TABLE publishes')
  }
  if (tableExists(db, 'oauth_tokens')) db.exec('DROP TABLE oauth_tokens')

  // 'published' meant "at least one platform took it", which posts now records
  // directly. 'ready' is the right resting state for a partially posted video.
  // Guarded by tableExists: several migrate.test.ts fixtures build a bare
  // handle that never declares `library` at all, and this step must stay a
  // no-op on them like every other step here does for the table it doesn't
  // find.
  if (tableExists(db, 'library')) {
    db.prepare("UPDATE library SET state = 'ready' WHERE state = 'published'").run()
  }
}

// Story-mode columns on `topics`. Five plain ADD COLUMNs, each probed
// independently so a database that got some of them from schema.sql and some
// from a partial earlier run converges either way.
//
// The two indexes are created HERE rather than in schema.sql, and the order
// within this function is the reason: openDb execs schema.sql BEFORE calling
// migrate, so an index over series_key/part_index placed there would throw on
// every existing database — those columns arrive via the ALTER TABLEs below.
// A throw during openDb wedges every CLI command, so the index is created
// here, after the columns it references exist.
const TOPIC_STORY_COLUMNS: [string, string][] = [
  ['body_text', 'TEXT'],
  ['series_key', 'TEXT'],
  ['part_index', 'INTEGER'],
  ['part_count', 'INTEGER'],
  ['truncated', 'INTEGER NOT NULL DEFAULT 0'],
]

function addTopicStoryColumns(db: Database): void {
  if (!tableExists(db, 'topics')) return
  for (const [column, type] of TOPIC_STORY_COLUMNS) {
    if (hasColumn(db, 'topics', column)) continue
    db.exec(`ALTER TABLE topics ADD COLUMN ${column} ${type}`)
  }
  // Only after every column above exists. IF NOT EXISTS makes both idempotent,
  // and neither can fail on data the way a UNIQUE index could.
  db.exec('CREATE INDEX IF NOT EXISTS ix_topics_job ON topics (job_id)')
  db.exec('CREATE INDEX IF NOT EXISTS ix_topics_series ON topics (series_key, part_index)')
}

/**
 * Idempotent post-schema migration for changes CREATE TABLE IF NOT EXISTS
 * cannot express against an existing database: SQLite cannot ALTER a CHECK
 * constraint or retype a column, and ADD COLUMN is not part of schema.sql's
 * declarative form. Every step inspects state before acting, so re-running is
 * a no-op. Called by openDb only — never by openDbReadonly, which must stay
 * write-free.
 */
export function migrate(db: Database): void {
  // The submission target behind a scouted topic. Backfilled for existing rows
  // by `brainrot topics prune-media`, which is the only thing that can recover
  // it — topics.url is the comments permalink, not the target.
  if (tableExists(db, 'topics') && !hasColumn(db, 'topics', 'target_url')) {
    db.exec('ALTER TABLE topics ADD COLUMN target_url TEXT')
  }
  // Marks an object deliberately deleted after every declared platform was
  // posted (posts/reclaim.ts). NULL means the bytes are still in the bucket,
  // which is the correct reading for every pre-existing row.
  if (tableExists(db, 'library_objects') && !hasColumn(db, 'library_objects', 'reclaimed_at')) {
    db.exec('ALTER TABLE library_objects ADD COLUMN reclaimed_at TEXT')
  }
  migratePublishesToPosts(db)
  addTopicStoryColumns(db)
}
