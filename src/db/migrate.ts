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

// The statuses that mean "this video has gone, or is going, to this platform"
// — exactly channelVideoCandidates' blocking set (publish/publishes.ts). One
// text so the index and that read cannot drift apart.
const LIVE_PUBLISH_STATUSES = "'claimed','done','interrupted'"

const LIVE_PUBLISH_INDEX = 'ux_publishes_live'

function liveIndexExists(db: Database): boolean {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?")
    .get(LIVE_PUBLISH_INDEX)
  return row !== undefined
}

/**
 * The (job, platform) pairs that already hold more than one live row — i.e.
 * the rows CREATE UNIQUE INDEX would reject. Empty on every database whose
 * history is consistent, which is every database that has not actually
 * double-published.
 */
function liveDuplicates(db: Database): { job_id: string; platform: string }[] {
  return db
    .prepare(
      `SELECT job_id, platform FROM publishes WHERE status IN (${LIVE_PUBLISH_STATUSES})
       GROUP BY job_id, platform HAVING COUNT(*) > 1 ORDER BY job_id, platform`,
    )
    .all() as { job_id: string; platform: string }[]
}

/**
 * The database-level double-publish backstop (design spec §7): at most one
 * live publishes row per (job_id, platform), which is the same rule
 * `channelVideoCandidates` applies when it decides a platform is blocked. With
 * it, a second lease holder racing the first fails at the INSERT, and
 * claimPublish's existing SQLITE_CONSTRAINT_UNIQUE → null path reports
 * `claim-conflict` before any upload happens.
 *
 * PROBED, not created blind, and deliberately absent from schema.sql. openDb
 * execs schema.sql and calls this on EVERY command, so a violating historical
 * row would make an unguarded CREATE UNIQUE INDEX throw at startup and wedge
 * the whole CLI — including `publish mark-done` and `publish retry`, the very
 * commands that resolve the violation. So: violations are reported and the
 * index is skipped, leaving behavior exactly as it was before this step
 * existed (lease + blocking read), and the next open after an operator clears
 * them creates it. A skip is a degraded guarantee; a wedge is an outage.
 *
 * Both resolution paths — `retryInterrupted` and `markPublishFailed` — move a
 * row to 'failed', which is outside the predicate, so the index never blocks a
 * legitimate retry.
 */
function ensureLivePublishIndex(db: Database, onWarn: (message: string) => void): void {
  if (liveIndexExists(db)) return
  const dupes = liveDuplicates(db)
  if (dupes.length > 0) {
    const pairs = dupes.map((d) => `${d.job_id}/${d.platform}`).join(', ')
    onWarn(
      `publishes: skipping unique index ${LIVE_PUBLISH_INDEX} — ${dupes.length} (job, platform) ` +
        `pair(s) hold more than one live (${LIVE_PUBLISH_STATUSES}) row: ${pairs}. ` +
        'Resolve each with `brainrot publish mark-done <jobId>` or `brainrot publish retry ' +
        "<jobId>` (both move the stale row to 'failed'), then reopen to create the index. " +
        'Until then the publish lease is the only double-publish guard.',
    )
    return
  }
  db.exec(
    `CREATE UNIQUE INDEX IF NOT EXISTS ${LIVE_PUBLISH_INDEX} ON publishes (job_id, platform) ` +
      `WHERE status IN (${LIVE_PUBLISH_STATUSES})`,
  )
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
 *
 * `onWarn` is where a step that declined to apply itself reports why. It goes
 * to stderr (console.warn), never stdout: every loop tick and CLI command
 * prints a single JSON line, and a warning must not land in it.
 */
export function migrate(
  db: Database,
  schemaSql: string,
  onWarn: (message: string) => void = (m) => console.warn(m),
): void {
  if (!hasColumn(db, 'oauth_tokens', 'expires_at')) {
    db.exec('ALTER TABLE oauth_tokens ADD COLUMN expires_at TEXT')
  }
  // The submission target behind a scouted topic. Backfilled for existing rows
  // by `brainrot topics prune-media`, which is the only thing that can recover
  // it — topics.url is the comments permalink, not the target.
  if (tableExists(db, 'topics') && !hasColumn(db, 'topics', 'target_url')) {
    db.exec('ALTER TABLE topics ADD COLUMN target_url TEXT')
  }
  // Marks an object deliberately deleted after every declared platform
  // settled (publish/reclaim.ts). NULL means the bytes are still in the
  // bucket, which is the correct reading for every pre-existing row.
  if (tableExists(db, 'library_objects') && !hasColumn(db, 'library_objects', 'reclaimed_at')) {
    db.exec('ALTER TABLE library_objects ADD COLUMN reclaimed_at TEXT')
  }
  if (hasColumn(db, 'publishes', 'slot') || publishesHasOldCheck(db)) {
    rebuildPublishes(db, schemaSql)
  }
  // After the rebuild: a rebuilt table is a new table with no indexes on it.
  ensureLivePublishIndex(db, onWarn)
}
