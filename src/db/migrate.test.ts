import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import BetterSqlite3 from 'better-sqlite3'
import type { Database } from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { openDb } from './index.js'
import { migrate } from './migrate.js'

// The CURRENT canonical schema — the same text openDb hands migrate(). Read
// from disk rather than copied so the rebuild is exercised against whatever
// shape schema.sql actually declares today.
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

// The publishes shape as of the clock-time-slot era: `slot TEXT NOT NULL` and
// UNIQUE (channel, platform, day, slot), platform CHECK already widened. This
// is what a database that has run the previous migration looks like. Do not
// import schema.sql here: these fixtures must stay frozen to the OLD shapes
// even as schema.sql moves on.
const OLD_SCHEMA_WITH_SLOT = `${OLD_JOBS}
CREATE TABLE IF NOT EXISTS publishes (
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
`

// The even older shape: the narrow platform CHECK, and no oauth_tokens
// expires_at. Every database carrying that CHECK also has `slot`, which is why
// the two rebuilds fold into one step — this fixture is what proves the fold
// still fixes the CHECK.
const OLD_SCHEMA = `${OLD_JOBS}
CREATE TABLE IF NOT EXISTS publishes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT NOT NULL REFERENCES jobs(id),
  platform TEXT NOT NULL CHECK (platform IN ('youtube')),
  channel TEXT NOT NULL,
  day TEXT NOT NULL, slot TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('claimed','done','failed','interrupted')),
  post_id TEXT, url TEXT, error TEXT,
  error_kind TEXT CHECK (error_kind IN ('auth','quota','rejected','transient')),
  attempt INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  finished_at TEXT,
  UNIQUE (channel, platform, day, slot)
);
CREATE TABLE IF NOT EXISTS oauth_tokens (
  platform TEXT NOT NULL, channel TEXT NOT NULL,
  token_ciphertext BLOB NOT NULL, scopes TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (platform, channel)
);
`

function oldShapeDb(): { db: Database; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'migrate-'))
  const db = new BetterSqlite3(join(dir, 'test.db'))
  db.pragma('foreign_keys = OFF')
  db.exec(OLD_SCHEMA)
  return { db, dir }
}

/**
 * An old-shape database on disk, seeded and CLOSED, for the tests that drive
 * the real openDb path (schema.sql exec, then migrate) rather than calling
 * migrate on a handle they already hold. Returns the path so the test can
 * reopen it — a second open is exactly how idempotence is observed in
 * production. Seed rows are inserted on this handle because it is the one with
 * foreign_keys OFF, matching openDb (these fixtures skip the jobs rows the
 * publishes FK names).
 */
function oldShapeFile(ddl: string, seed?: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'migrate-'))
  cleanupDirs.push(dir)
  const dbPath = join(dir, 'test.db')
  const raw = new BetterSqlite3(dbPath)
  raw.pragma('foreign_keys = OFF')
  raw.exec(ddl)
  if (seed !== undefined) raw.exec(seed)
  raw.close()
  return dbPath
}

const cleanupDirs: string[] = []
afterEach(() => {
  for (const d of cleanupDirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe('migrate', () => {
  it('adds oauth_tokens.expires_at when absent', () => {
    const { db, dir } = oldShapeDb()
    cleanupDirs.push(dir)
    migrate(db, SCHEMA_SQL)
    const cols = db.prepare('PRAGMA table_info(oauth_tokens)').all() as { name: string }[]
    expect(cols.map((c) => c.name)).toContain('expires_at')
  })

  it('drops the platform CHECK on publishes while preserving existing rows', () => {
    const { db, dir } = oldShapeDb()
    cleanupDirs.push(dir)
    db.prepare(
      "INSERT INTO jobs (id, channel, tier, topic, status) VALUES ('job-1', 'test', 'volume', 'topic', 'done')",
    ).run()
    db.prepare(
      'INSERT INTO publishes (job_id, platform, channel, day, slot, status, attempt) ' +
        "VALUES ('job-1', 'youtube', 'test', '2026-07-25', '10:00', 'done', 1)",
    ).run()

    migrate(db, SCHEMA_SQL)

    // The CHECK is gone: an 'instagram' row now inserts without throwing.
    expect(() =>
      db
        .prepare(
          'INSERT INTO publishes (job_id, platform, channel, day, seq, status, attempt) ' +
            "VALUES ('job-1', 'instagram', 'test', '2026-07-25', 1, 'done', 1)",
        )
        .run(),
    ).not.toThrow()

    const rows = db.prepare('SELECT job_id, platform, status FROM publishes ORDER BY id').all()
    expect(rows).toEqual([
      { job_id: 'job-1', platform: 'youtube', status: 'done' },
      { job_id: 'job-1', platform: 'instagram', status: 'done' },
    ])
  })

  it('never reuses an id after the table rebuild', () => {
    const { db, dir } = oldShapeDb()
    cleanupDirs.push(dir)
    db.prepare(
      "INSERT INTO jobs (id, channel, tier, topic, status) VALUES ('job-1', 'test', 'volume', 'topic', 'done')",
    ).run()
    const info = db
      .prepare(
        'INSERT INTO publishes (job_id, platform, channel, day, slot, status, attempt) ' +
          "VALUES ('job-1', 'youtube', 'test', '2026-07-25', '10:00', 'done', 1)",
      )
      .run()
    const oldId = Number(info.lastInsertRowid)

    migrate(db, SCHEMA_SQL)

    const newInfo = db
      .prepare(
        'INSERT INTO publishes (job_id, platform, channel, day, seq, status, attempt) ' +
          "VALUES ('job-1', 'instagram', 'test', '2026-07-25', 1, 'done', 1)",
      )
      .run()
    expect(Number(newInfo.lastInsertRowid)).toBeGreaterThan(oldId)
  })

  it('is idempotent: running twice does nothing the second time', () => {
    const { db, dir } = oldShapeDb()
    cleanupDirs.push(dir)
    migrate(db, SCHEMA_SQL)
    expect(() => migrate(db, SCHEMA_SQL)).not.toThrow()
    const cols = db.prepare('PRAGMA table_info(oauth_tokens)').all() as { name: string }[]
    expect(cols.filter((c) => c.name === 'expires_at')).toHaveLength(1)
  })

  it('is a no-op against a database already on the new shape', () => {
    // A DB created fresh via the current schema.sql already has no CHECK, no
    // `slot` column, and an expires_at — migrate() must not touch it.
    const dir = mkdtempSync(join(tmpdir(), 'migrate-'))
    cleanupDirs.push(dir)
    const db = new BetterSqlite3(join(dir, 'test.db'))
    db.pragma('foreign_keys = OFF')
    db.exec(`
      CREATE TABLE publishes (
        id INTEGER PRIMARY KEY AUTOINCREMENT, job_id TEXT NOT NULL, platform TEXT NOT NULL,
        channel TEXT NOT NULL, day TEXT NOT NULL, seq INTEGER NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('claimed','done','failed','interrupted')),
        post_id TEXT, url TEXT, error TEXT,
        error_kind TEXT CHECK (error_kind IN ('auth','quota','rejected','transient')),
        attempt INTEGER NOT NULL,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), finished_at TEXT,
        UNIQUE (channel, platform, day, seq)
      );
      CREATE TABLE oauth_tokens (
        platform TEXT NOT NULL, channel TEXT NOT NULL, token_ciphertext BLOB NOT NULL,
        scopes TEXT NOT NULL, expires_at TEXT,
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        PRIMARY KEY (platform, channel)
      );
    `)
    expect(() => migrate(db, SCHEMA_SQL)).not.toThrow()
  })
})

describe('migrate — slot to seq', () => {
  it('maps slot to a 1-based seq per (channel, platform, day), ordered by slot', () => {
    const dbPath = oldShapeFile(
      OLD_SCHEMA_WITH_SLOT,
      'INSERT INTO publishes (id, job_id, platform, channel, day, slot, status, attempt, created_at) VALUES ' +
        "(1,'job-c','youtube','chan-a','2026-07-22','19:00','done',1,'2026-07-22T19:00:00.000Z')," +
        "(2,'job-a','youtube','chan-a','2026-07-22','10:00','done',1,'2026-07-22T10:00:00.000Z')," +
        "(3,'job-b','youtube','chan-a','2026-07-22','14:00','failed',1,'2026-07-22T14:00:00.000Z')," +
        "(4,'job-a','instagram','chan-a','2026-07-22','10:00','done',1,'2026-07-22T10:05:00.000Z')," +
        "(5,'job-z','youtube','chan-b','2026-07-21','10:00','done',1,'2026-07-21T10:00:00.000Z')",
    )

    const db = openDb(dbPath)
    const rows = db
      .prepare('SELECT id, channel, platform, day, seq FROM publishes ORDER BY id')
      .all() as { id: number; channel: string; platform: string; day: string; seq: number }[]
    // chan-a/youtube/2026-07-22 ranked by slot: 10:00 -> 1, 14:00 -> 2, 19:00 -> 3.
    expect(rows.find((r) => r.id === 2)?.seq).toBe(1)
    expect(rows.find((r) => r.id === 3)?.seq).toBe(2)
    expect(rows.find((r) => r.id === 1)?.seq).toBe(3)
    // A different platform is its own partition, so it restarts at 1.
    expect(rows.find((r) => r.id === 4)?.seq).toBe(1)
    // As is a different channel and day.
    expect(rows.find((r) => r.id === 5)?.seq).toBe(1)
    db.close()
  })

  it('is a no-op on a second open (idempotent)', () => {
    const dbPath = oldShapeFile(
      OLD_SCHEMA_WITH_SLOT,
      'INSERT INTO publishes (id, job_id, platform, channel, day, slot, status, attempt) VALUES ' +
        "(1,'job-a','youtube','chan-a','2026-07-22','10:00','done',1)",
    )

    const first = openDb(dbPath)
    first.close()
    const second = openDb(dbPath)
    const rows = second.prepare('SELECT id, seq FROM publishes ORDER BY id').all()
    expect(rows).toEqual([{ id: 1, seq: 1 }])
    second.close()
  })

  it('leaves a fresh database untouched', () => {
    const dir = mkdtempSync(join(tmpdir(), 'migrate-'))
    cleanupDirs.push(dir)
    const db = openDb(join(dir, 'fresh.db'))
    expect(() => db.prepare('SELECT seq FROM publishes').all()).not.toThrow()
    expect(db.prepare('SELECT COUNT(*) AS n FROM publishes').get()).toEqual({ n: 0 })
    db.close()
  })

  it('drops publishes_old after a successful rebuild', () => {
    const dbPath = oldShapeFile(OLD_SCHEMA_WITH_SLOT)
    const db = openDb(dbPath)
    const found = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='publishes_old'")
      .get()
    expect(found).toBeUndefined()
    db.close()
  })
})
