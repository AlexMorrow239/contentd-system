import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import BetterSqlite3 from 'better-sqlite3'
import type { Database } from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { migrate } from './migrate.js'

// The exact OLD schema.sql shape (platform CHECK present, no expires_at) —
// this is what every database created before this plan actually looks like.
// Do not import schema.sql here: this fixture must stay frozen to the OLD
// shape even after schema.sql changes in Task 1's own next step.
const OLD_SCHEMA = `
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY, channel TEXT NOT NULL, tier TEXT NOT NULL CHECK (tier IN ('volume','premium')),
  topic TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued','running','failed','done','blocked')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  finished_at TEXT
);
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

const cleanupDirs: string[] = []
afterEach(() => {
  for (const d of cleanupDirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe('migrate', () => {
  it('adds oauth_tokens.expires_at when absent', () => {
    const { db, dir } = oldShapeDb()
    cleanupDirs.push(dir)
    migrate(db)
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

    migrate(db)

    // The CHECK is gone: an 'instagram' row now inserts without throwing.
    expect(() =>
      db
        .prepare(
          'INSERT INTO publishes (job_id, platform, channel, day, slot, status, attempt) ' +
            "VALUES ('job-1', 'instagram', 'test', '2026-07-25', '11:00', 'done', 1)",
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

    migrate(db)

    const newInfo = db
      .prepare(
        'INSERT INTO publishes (job_id, platform, channel, day, slot, status, attempt) ' +
          "VALUES ('job-1', 'instagram', 'test', '2026-07-25', '11:00', 'done', 1)",
      )
      .run()
    expect(Number(newInfo.lastInsertRowid)).toBeGreaterThan(oldId)
  })

  it('is idempotent: running twice does nothing the second time', () => {
    const { db, dir } = oldShapeDb()
    cleanupDirs.push(dir)
    migrate(db)
    expect(() => migrate(db)).not.toThrow()
    const cols = db.prepare('PRAGMA table_info(oauth_tokens)').all() as { name: string }[]
    expect(cols.filter((c) => c.name === 'expires_at')).toHaveLength(1)
  })

  it('is a no-op against a database already on the new shape', () => {
    // A DB created fresh via the new schema.sql (post Task 1 step 3) already
    // has no CHECK and already has expires_at — migrate() must not touch it.
    const dir = mkdtempSync(join(tmpdir(), 'migrate-'))
    cleanupDirs.push(dir)
    const db = new BetterSqlite3(join(dir, 'test.db'))
    db.pragma('foreign_keys = OFF')
    db.exec(`
      CREATE TABLE publishes (
        id INTEGER PRIMARY KEY AUTOINCREMENT, job_id TEXT NOT NULL, platform TEXT NOT NULL,
        channel TEXT NOT NULL, day TEXT NOT NULL, slot TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('claimed','done','failed','interrupted')),
        post_id TEXT, url TEXT, error TEXT,
        error_kind TEXT CHECK (error_kind IN ('auth','quota','rejected','transient')),
        attempt INTEGER NOT NULL,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), finished_at TEXT,
        UNIQUE (channel, platform, day, slot)
      );
      CREATE TABLE oauth_tokens (
        platform TEXT NOT NULL, channel TEXT NOT NULL, token_ciphertext BLOB NOT NULL,
        scopes TEXT NOT NULL, expires_at TEXT,
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        PRIMARY KEY (platform, channel)
      );
    `)
    expect(() => migrate(db)).not.toThrow()
  })
})
