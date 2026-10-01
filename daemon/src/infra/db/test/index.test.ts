import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { memDb } from '../../../../testing/db.js'
import { tmpDir } from '../../../../testing/tmp.js'
import { openDbActions, openDbReadonly } from '../dashboard.js'
import { openDb } from '../index.js'

function tempDbPath(): string {
  const dir = tmpDir('brainrot-db-')
  return join(dir, 'nested', 'brainrot.db') // 'nested' does not exist yet
}

describe('openDb', () => {
  it('creates the parent directory and all tables', () => {
    const db = openDb(tempDbPath())
    const names = (
      db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as {
        name: string
      }[]
    ).map((r) => r.name)
    expect(names).toContain('jobs')
    expect(names).toContain('job_stages')
    expect(names).toContain('library')
    expect(names).toContain('costs')
    expect(names).toContain('bg_usage')
    db.close()
  })

  it('is idempotent: reopening the same file succeeds', () => {
    const path = tempDbPath()
    const first = openDb(path)
    first.close()
    const second = openDb(path)
    const rows = second
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='jobs'")
      .all()
    expect(rows).toHaveLength(1)
    second.close()
  })

  it('enables WAL journal mode', () => {
    const db = openDb(tempDbPath())
    const mode = db.pragma('journal_mode', { simple: true })
    expect(mode).toBe('wal')
    db.close()
  })

  it('sets a 5s busy_timeout so co-firing writers wait out lock windows', () => {
    // The daemon's produce/scout/digest/actions-fast/actions-slow workers run
    // concurrently in one process (daemon/src/app/daemon.ts), and manual CLI
    // commands (produce, resume, library approve, ...) can run as separate
    // processes against the same SQLite file at the same time; without this
    // an overlapping write window throws SQLITE_BUSY and crashes a run
    // mid-flight.
    const db = openDb(tempDbPath())
    expect(db.pragma('busy_timeout', { simple: true })).toBe(5000)
    db.close()
  })
})

describe('openDbReadonly', () => {
  it('reads an existing database', () => {
    const path = tempDbPath()
    const writable = openDb(path)
    writable
      .prepare("INSERT INTO jobs (id, channel, tier, topic) VALUES ('j1','c','volume','t')")
      .run()
    writable.close()

    const db = openDbReadonly(path)
    const rows = db.prepare('SELECT id FROM jobs').all() as { id: string }[]
    expect(rows).toEqual([{ id: 'j1' }])
    db.close()
  })

  it('rejects writes', () => {
    const path = tempDbPath()
    openDb(path).close()

    const db = openDbReadonly(path)
    expect(() =>
      db.prepare("INSERT INTO jobs (id, channel, tier, topic) VALUES ('x','c','volume','t')").run(),
    ).toThrow(/readonly/i)
    db.close()
  })

  it('throws on a missing file instead of creating one', () => {
    // A viewer that conjures the database it failed to find reports zeroes
    // instead of "missing", which is worse than an error.
    const path = join(tmpDir('brainrot-ro-'), 'absent.db')
    expect(() => openDbReadonly(path)).toThrow()
    expect(existsSync(path)).toBe(false)
  })

  it('sets a 5s busy_timeout so a cron tick write is waited out, not thrown on', () => {
    const path = tempDbPath()
    openDb(path).close()
    const db = openDbReadonly(path)
    expect(db.pragma('busy_timeout', { simple: true })).toBe(5000)
    db.close()
  })
})

describe('openDbActions', () => {
  it('throws on a missing path without creating its parent directory', () => {
    const root = tmpDir('brainrot-actions-')
    const missingParent = join(root, 'nope')
    const missing = join(missingParent, 'brainrot.db')
    // fileMustExist: a viewer pointed at the wrong root must report, not create.
    expect(() => openDbActions(missing)).toThrow(/cannot open database/i)
    // And it must not have mkdir'd the parent while failing to open.
    expect(existsSync(missingParent)).toBe(false)
  })

  it('opens an existing empty file without execing schema.sql or running migrations', () => {
    const root = tmpDir('brainrot-actions-')
    const path = join(root, 'empty.db')
    writeFileSync(path, '') // a valid, empty SQLite file: zero tables
    const db = openDbActions(path)
    const rows = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()
    // If a future edit "fixes" a missing-table error by adding a schema exec
    // or migrate call to openDbActions, this goes from empty to populated.
    expect(rows).toHaveLength(0)
    db.close()
  })

  it('is genuinely writable: can insert into operator_actions', () => {
    const root = tmpDir('brainrot-actions-')
    const path = join(root, 'brainrot.db')
    openDb(path).close() // creates schema, including operator_actions

    const db = openDbActions(path)
    db.prepare(
      "INSERT INTO operator_actions (kind, lane, args, status, requested_by) VALUES ('topics.reject','fast','{}','pending','dashboard')",
    ).run()
    const rows = db.prepare('SELECT kind FROM operator_actions').all() as { kind: string }[]
    expect(rows).toEqual([{ kind: 'topics.reject' }])
    db.close()
  })
})

describe('schemas', () => {
  it('creates the operator_actions table with its lane and status checks', () => {
    const db = memDb()
    const cols = db.prepare('PRAGMA table_info(operator_actions)').all() as { name: string }[]
    expect(cols.map((c) => c.name)).toEqual([
      'id',
      'kind',
      'lane',
      'args',
      'status',
      'requested_by',
      'created_at',
      'started_at',
      'finished_at',
      'result',
      'error',
      'error_kind',
      'notice',
      'owner_token',
      'job_id',
    ])
    expect(() =>
      db
        .prepare(
          "INSERT INTO operator_actions (kind, lane, args, status, requested_by) VALUES ('x','sideways','{}','pending','dashboard')",
        )
        .run(),
    ).toThrow(/CHECK constraint/)
  })

  it('creates a single-row daemon_state table', () => {
    const db = memDb()
    const cols = db.prepare('PRAGMA table_info(daemon_state)').all() as { name: string }[]
    expect(cols.map((c) => c.name)).toEqual(['id', 'pid', 'started_at', 'last_seen_at'])
    db.prepare(
      "INSERT INTO daemon_state (id, pid, started_at, last_seen_at) VALUES (1, 7, 'a', 'b')",
    ).run()
    expect(() =>
      db
        .prepare(
          "INSERT INTO daemon_state (id, pid, started_at, last_seen_at) VALUES (2, 8, 'a', 'b')",
        )
        .run(),
    ).toThrow(/CHECK constraint/)
  })
})
