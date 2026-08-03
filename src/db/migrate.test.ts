import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import BetterSqlite3 from 'better-sqlite3'
import type { Database } from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { openDb } from './index.js'
import { migrate } from './migrate.js'
import { memDb, seedJob, seedLibrary, seedLibraryObject } from '../testing/db.js'
import { tmpDir } from '../testing/tmp.js'

// The CURRENT canonical schema — the same text openDb hands migrate(). Read
// from disk rather than copied so it never drifts from what schema.sql
// actually declares today.
const SCHEMA_SQL = readFileSync(new URL('./schema.sql', import.meta.url), 'utf8')

const OLD_JOBS = `
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY, channel TEXT NOT NULL, tier TEXT NOT NULL CHECK (tier IN ('volume','premium')),
  topic TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued','running','failed','done','blocked')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  finished_at TEXT
);
`

// The topics shape before target_url existed. Frozen here for the same reason
// as the fixtures above: it must keep describing the OLD shape as schema.sql
// moves on.
const OLD_TOPICS = `
CREATE TABLE IF NOT EXISTS topics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel TEXT NOT NULL, title TEXT NOT NULL,
  raw_title TEXT NOT NULL, source TEXT NOT NULL,
  url TEXT NOT NULL, dedupe_hash TEXT NOT NULL,
  score INTEGER NOT NULL, reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'candidate'
    CHECK (status IN ('candidate','claimed','used','rejected')),
  job_id TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (channel, dedupe_hash)
);
`

function colNames(db: Database, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name)
}

const cleanupDirs: string[] = []
afterEach(() => {
  for (const d of cleanupDirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe('migrate', () => {
  it('adds library_objects.reclaimed_at to a database that predates it', () => {
    const db = memDb()
    db.exec('DROP TABLE library_objects')
    db.exec(`CREATE TABLE library_objects (
      job_id TEXT PRIMARY KEY,
      object_key TEXT NOT NULL,
      bytes INTEGER NOT NULL,
      etag TEXT NOT NULL,
      uploaded_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    )`)

    migrate(db)

    const cols = (db.prepare('PRAGMA table_info(library_objects)').all() as { name: string }[]).map(
      (c) => c.name,
    )
    expect(cols).toContain('reclaimed_at')
  })

  it('leaves an already-migrated library_objects alone', () => {
    const db = memDb()
    db.prepare(
      'INSERT INTO library_objects (job_id, object_key, bytes, etag, reclaimed_at) VALUES (?, ?, ?, ?, ?)',
    ).run('job-1', 'videos/a.mp4', 10, 'etag', '2026-07-01T00:00:00.000Z')

    migrate(db)

    const row = db.prepare('SELECT reclaimed_at AS at FROM library_objects WHERE job_id = ?').get('job-1') as
      { at: string | null }
    expect(row.at).toBe('2026-07-01T00:00:00.000Z')
  })
})

describe('migrate — topics.target_url', () => {
  // A bare handle carrying only what these tests exercise: none of migrate's
  // OTHER steps depend on any table besides the one they name, and each is
  // its own tableExists-guarded no-op when that table is absent.
  function topicsDb(ddl: string): Database {
    const dir = tmpDir('brainrot-migrate-')
    cleanupDirs.push(dir)
    const db = new BetterSqlite3(join(dir, 'test.db'))
    db.pragma('foreign_keys = OFF')
    db.exec(ddl)
    return db
  }

  it('adds target_url to a topics table that predates it', () => {
    const db = topicsDb(OLD_TOPICS)
    expect(colNames(db, 'topics')).not.toContain('target_url')

    migrate(db)

    expect(colNames(db, 'topics')).toContain('target_url')
  })

  it('preserves existing rows, leaving the new column null', () => {
    const db = topicsDb(OLD_TOPICS)
    db.exec(
      "INSERT INTO topics (channel, title, raw_title, source, url, dedupe_hash, score, reason) " +
        "VALUES ('chan-a', 'A topic', 'A topic', 'reddit:r/space', 'https://e.invalid/x', 'h1', 80, 'seeded')",
    )

    migrate(db)

    expect(db.prepare('SELECT title, target_url FROM topics').all()).toEqual([
      { title: 'A topic', target_url: null },
    ])
  })

  it('is idempotent: a second run adds no duplicate column', () => {
    const db = topicsDb(OLD_TOPICS)
    migrate(db)
    expect(() => migrate(db)).not.toThrow()
    expect(colNames(db, 'topics').filter((n) => n === 'target_url')).toHaveLength(1)
  })

  it('skips the step entirely when there is no topics table', () => {
    // openDb execs schema.sql before calling migrate, so topics always exists
    // in production. The probe is what keeps a caller holding a bare handle —
    // every fixture above — from hitting "no such table".
    const db = topicsDb(OLD_JOBS)
    expect(() => migrate(db)).not.toThrow()
  })
})

// The topics shape after target_url exists but before the story columns did
// — the actual predecessor state this step migrates from.
const TOPICS_PRE_STORY = `
CREATE TABLE topics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel TEXT NOT NULL, title TEXT NOT NULL,
  raw_title TEXT NOT NULL, source TEXT NOT NULL,
  url TEXT NOT NULL, target_url TEXT, dedupe_hash TEXT NOT NULL,
  score INTEGER NOT NULL, reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'candidate'
    CHECK (status IN ('candidate','claimed','used','rejected')),
  job_id TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (channel, dedupe_hash)
);
`

describe('addTopicStoryColumns', () => {
  it('adds the story columns to a topics table that predates them', () => {
    const dir = tmpDir('brainrot-migrate-')
    cleanupDirs.push(dir)
    const db = new BetterSqlite3(join(dir, 'test.db'))
    db.pragma('foreign_keys = OFF')
    db.exec(TOPICS_PRE_STORY)
    db.prepare(
      'INSERT INTO topics (channel, title, raw_title, source, url, dedupe_hash, score, reason) ' +
        "VALUES ('space','t','t','reddit:r/space','u','h',90,'r')",
    ).run()

    migrate(db)

    const cols = (db.prepare('PRAGMA table_info(topics)').all() as { name: string }[]).map(
      (c) => c.name,
    )
    expect(cols).toContain('body_text')
    expect(cols).toContain('series_key')
    expect(cols).toContain('part_index')
    expect(cols).toContain('part_count')
    expect(cols).toContain('truncated')
    // The pre-existing row survives with nulls and a zero default.
    const row = db.prepare('SELECT body_text, truncated FROM topics').get() as {
      body_text: string | null
      truncated: number
    }
    expect(row.body_text).toBeNull()
    expect(row.truncated).toBe(0)
    // Both indexes exist, which is only possible if they were created AFTER
    // the columns — schema.sql cannot carry them for exactly that reason.
    const indexes = (
      db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'topics'")
        .all() as { name: string }[]
    ).map((i) => i.name)
    expect(indexes).toContain('ix_topics_job')
    expect(indexes).toContain('ix_topics_series')
    db.close()
  })

  it('converges a database with a partial set of story columns', () => {
    // Regression: a database that got some columns from schema.sql and some
    // from a partial earlier run must converge to have all five. This catches
    // a regression to a single-sentinel probe like
    // `if (!hasColumn(db,'topics','body_text')) { add all five }`, which would
    // pass the none-present and fresh-database tests while failing on partial.
    const dir = tmpDir('brainrot-migrate-')
    cleanupDirs.push(dir)
    const dbPath = join(dir, 'test.db')
    const raw = new BetterSqlite3(dbPath)
    raw.pragma('foreign_keys = OFF')
    // Start with TOPICS_PRE_STORY and manually add TWO of the five columns.
    raw.exec(TOPICS_PRE_STORY)
    raw.exec('ALTER TABLE topics ADD COLUMN body_text TEXT')
    raw.exec('ALTER TABLE topics ADD COLUMN part_count INTEGER')
    raw.prepare(
      'INSERT INTO topics (channel, title, raw_title, source, url, dedupe_hash, score, reason, body_text) ' +
        "VALUES ('space','t','t','reddit:r/space','u','h',90,'r','part 1')",
    ).run()
    raw.close()

    const db = openDb(dbPath)

    const cols = (db.prepare('PRAGMA table_info(topics)').all() as { name: string }[]).map(
      (c) => c.name,
    )
    // All five story columns must exist.
    expect(cols).toContain('body_text')
    expect(cols).toContain('series_key')
    expect(cols).toContain('part_index')
    expect(cols).toContain('part_count')
    expect(cols).toContain('truncated')
    // Both indexes must exist.
    const indexes = (
      db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'topics'")
        .all() as { name: string }[]
    ).map((i) => i.name)
    expect(indexes).toContain('ix_topics_job')
    expect(indexes).toContain('ix_topics_series')
    // Pre-existing data in body_text survives.
    const row = db.prepare('SELECT body_text FROM topics').get() as { body_text: string | null }
    expect(row.body_text).toBe('part 1')
    db.close()
  })

  it('does not wedge openDb on a database predating the story columns', () => {
    // The regression this guards: putting the story indexes in schema.sql
    // throws here, because openDb execs schema.sql BEFORE migrate adds the
    // columns they reference — and that failure takes out every CLI command,
    // not just one.
    const dir = tmpDir('migrate-openDb')
    cleanupDirs.push(dir)
    const dbPath = join(dir, 'brainrot.db')
    const old = new BetterSqlite3(dbPath)
    old.exec(`CREATE TABLE topics (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      channel TEXT NOT NULL, title TEXT NOT NULL,
      raw_title TEXT NOT NULL, source TEXT NOT NULL,
      url TEXT NOT NULL, target_url TEXT, dedupe_hash TEXT NOT NULL,
      score INTEGER NOT NULL, reason TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'candidate',
      job_id TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      UNIQUE (channel, dedupe_hash)
    )`)
    old.close()

    const db = openDb(dbPath)
    expect(
      (db.prepare('PRAGMA table_info(topics)').all() as { name: string }[]).map((c) => c.name),
    ).toContain('series_key')
    db.close()
  })

  it('is a no-op on a database that already has them', () => {
    const db = new BetterSqlite3(':memory:')
    db.exec(SCHEMA_SQL)
    expect(() => migrate(db)).not.toThrow()
    expect(() => migrate(db)).not.toThrow()
    db.close()
  })
})

describe('publishes -> posts', () => {
  // A database as it existed before this change: schema.sql no longer
  // declares these tables, so the test creates them by hand, which is
  // exactly what an upgrading production database looks like.
  function seedLegacy(db: Database): void {
    db.exec(`
      CREATE TABLE publishes (
        id INTEGER PRIMARY KEY, job_id TEXT NOT NULL, channel TEXT NOT NULL,
        platform TEXT NOT NULL, status TEXT NOT NULL, url TEXT,
        error_kind TEXT, created_at TEXT NOT NULL, finished_at TEXT
      );
      CREATE TABLE oauth_tokens (channel TEXT NOT NULL, platform TEXT NOT NULL);
    `)
  }

  it('carries done rows over and discards the rest', () => {
    const db = memDb()
    seedLegacy(db)
    db.prepare(
      "INSERT INTO publishes (job_id, channel, platform, status, url, created_at) VALUES " +
        "('j1','alpha','youtube','done','https://y/1','2026-01-01T00:00:00.000Z')," +
        "('j2','alpha','instagram','failed',NULL,'2026-01-02T00:00:00.000Z')," +
        "('j3','alpha','youtube','claimed',NULL,'2026-01-03T00:00:00.000Z')",
    ).run()
    migrate(db)
    const rows = db.prepare('SELECT * FROM posts ORDER BY job_id').all()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      job_id: 'j1',
      channel: 'alpha',
      platform: 'youtube',
      url: 'https://y/1',
      posted_at: '2026-01-01T00:00:00.000Z',
    })
  })

  it('uses finished_at as posted_at when present, not created_at', () => {
    const db = memDb()
    seedLegacy(db)
    db.prepare(
      "INSERT INTO publishes (job_id, channel, platform, status, url, created_at, finished_at) " +
        "VALUES ('j1','alpha','youtube','done','https://y/1'," +
        "'2026-01-01T00:00:00.000Z','2026-01-01T00:05:00.000Z')",
    ).run()
    migrate(db)
    const row = db.prepare('SELECT posted_at FROM posts WHERE job_id = ?').get('j1')
    expect(row).toEqual({ posted_at: '2026-01-01T00:05:00.000Z' })
  })

  it('falls back to created_at when finished_at is null', () => {
    const db = memDb()
    seedLegacy(db)
    db.prepare(
      "INSERT INTO publishes (job_id, channel, platform, status, url, created_at, finished_at) " +
        "VALUES ('j1','alpha','youtube','done','https://y/1'," +
        "'2026-01-01T00:00:00.000Z',NULL)",
    ).run()
    migrate(db)
    const row = db.prepare('SELECT posted_at FROM posts WHERE job_id = ?').get('j1')
    expect(row).toEqual({ posted_at: '2026-01-01T00:00:00.000Z' })
  })

  it('drops both legacy tables', () => {
    const db = memDb()
    seedLegacy(db)
    migrate(db)
    const names = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all() as { name: string }[]
    expect(names.map((n) => n.name)).not.toContain('publishes')
    expect(names.map((n) => n.name)).not.toContain('oauth_tokens')
  })

  it("rewrites the retired 'published' library state to 'ready', and only that state", () => {
    const db = memDb()
    seedJob(db, 'j1', { channel: 'alpha' })
    seedLibrary(db, 'j1', { state: 'ready' })
    db.prepare("UPDATE library SET state = 'published' WHERE job_id = 'j1'").run()
    // Control rows: neither should be touched by the UPDATE's WHERE clause.
    // 'ready' is deliberately excluded as a control — a row already 'ready'
    // is indistinguishable from one wrongly rewritten to it.
    seedJob(db, 'j2', { channel: 'alpha' })
    seedLibrary(db, 'j2', { state: 'needs-review' })
    seedJob(db, 'j3', { channel: 'alpha' })
    seedLibrary(db, 'j3', { state: 'blocked' })
    migrate(db)
    const states = db
      .prepare('SELECT job_id, state FROM library ORDER BY job_id')
      .all() as { job_id: string; state: string }[]
    expect(states).toEqual([
      { job_id: 'j1', state: 'ready' },
      { job_id: 'j2', state: 'needs-review' },
      { job_id: 'j3', state: 'blocked' },
    ])
  })

  // Dropping the source table is what makes the step self-disabling, so
  // idempotence is free — but it has to be proven, not assumed.
  it('is a no-op on a database that has already migrated', () => {
    const db = memDb()
    seedLegacy(db)
    db.prepare(
      "INSERT INTO publishes (job_id, channel, platform, status, url, created_at) VALUES " +
        "('j1','alpha','youtube','done','https://y/1','2026-01-01T00:00:00.000Z')",
    ).run()
    migrate(db)
    expect(() => migrate(db)).not.toThrow()
    // Proves the second run neither re-backfills from a table that no longer
    // exists nor double-inserts the row the first run already carried over.
    expect(db.prepare('SELECT COUNT(*) AS n FROM posts').get()).toEqual({ n: 1 })
  })

  it('is a no-op on a fresh database', () => {
    const db = memDb()
    expect(() => migrate(db)).not.toThrow()
  })
})

describe('migrate — blocks library rows whose object was already reclaimed', () => {
  it("blocks a reclaimed 'ready' row", () => {
    const db = memDb()
    seedJob(db, 'j1', { channel: 'alpha' })
    seedLibrary(db, 'j1', { state: 'ready' })
    seedLibraryObject(db, 'j1', { reclaimedAt: '2026-07-01T00:00:00.000Z' })
    migrate(db)
    const row = db.prepare('SELECT state FROM library WHERE job_id = ?').get('j1') as {
      state: string
    }
    expect(row.state).toBe('blocked')
  })

  it("blocks a reclaimed 'published' row — NOT 'ready'", () => {
    const db = memDb()
    seedJob(db, 'j1', { channel: 'alpha' })
    seedLibrary(db, 'j1', { state: 'published' })
    seedLibraryObject(db, 'j1', { reclaimedAt: '2026-07-01T00:00:00.000Z' })
    migrate(db)
    const row = db.prepare('SELECT state FROM library WHERE job_id = ?').get('j1') as {
      state: string
    }
    // Must be 'blocked', proving the block step ran BEFORE the
    // 'published' -> 'ready' rewrite would otherwise have won this row.
    expect(row.state).toBe('blocked')
  })

  it("still rewrites a NON-reclaimed 'published' row to 'ready'", () => {
    const db = memDb()
    seedJob(db, 'j1', { channel: 'alpha' })
    seedLibrary(db, 'j1', { state: 'published' })
    // No library_objects row at all: nothing to reclaim.
    migrate(db)
    const row = db.prepare('SELECT state FROM library WHERE job_id = ?').get('j1') as {
      state: string
    }
    expect(row.state).toBe('ready')
  })

  it("leaves a NON-reclaimed 'ready' row untouched", () => {
    const db = memDb()
    seedJob(db, 'j1', { channel: 'alpha' })
    seedLibrary(db, 'j1', { state: 'ready' })
    seedLibraryObject(db, 'j1')
    migrate(db)
    const row = db.prepare('SELECT state FROM library WHERE job_id = ?').get('j1') as {
      state: string
    }
    expect(row.state).toBe('ready')
  })

  it('is idempotent: a second migrate() run leaves the blocked row blocked', () => {
    const db = memDb()
    seedJob(db, 'j1', { channel: 'alpha' })
    seedLibrary(db, 'j1', { state: 'ready' })
    seedLibraryObject(db, 'j1', { reclaimedAt: '2026-07-01T00:00:00.000Z' })
    migrate(db)
    expect(() => migrate(db)).not.toThrow()
    const row = db.prepare('SELECT state FROM library WHERE job_id = ?').get('j1') as {
      state: string
    }
    expect(row.state).toBe('blocked')
  })

  // Proves the ordering (and the "match BOTH states" requirement) actually
  // matters, rather than being defensive-but-inert. Simulates the adverse
  // case the block step must survive: the 'published' -> 'ready' rewrite has
  // ALREADY happened by the time the block check runs — either because a
  // database already applied an earlier migrate() that predates this fix (the
  // rewrite existed long before the block step did), or because a future
  // refactor swapped the two calls in migrate(). If the block step matched
  // only 'published' (the seemingly-sufficient state given it is meant to run
  // BEFORE the rewrite), this row would already be 'ready' by the time it
  // runs and would slip through untouched — reproducing finding 1's bug. The
  // 'ready' branch of the IN clause is what catches it regardless.
  it('still catches a reclaimed row that already reads as ready, as if the rewrite ran first', () => {
    const db = memDb()
    seedJob(db, 'j1', { channel: 'alpha' })
    // Seeded directly as 'ready' with reclaimed_at set — the state this row
    // would already be in if the 'published' -> 'ready' rewrite had run
    // ahead of the block step, whether by a swapped call order or by a prior
    // deploy of migrate() that predates this fix.
    seedLibrary(db, 'j1', { state: 'ready' })
    seedLibraryObject(db, 'j1', { reclaimedAt: '2026-07-01T00:00:00.000Z' })
    migrate(db)
    const row = db.prepare('SELECT state FROM library WHERE job_id = ?').get('j1') as {
      state: string
    }
    expect(row.state).toBe('blocked')
  })
})
