import { describe, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from './index.js'

function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'brainrot-db-'))
  return join(dir, 'nested', 'brainrot.db') // 'nested' does not exist yet
}

describe('openDb', () => {
  it('creates the parent directory and all tables', () => {
    const db = openDb(tempDbPath())
    const names = (
      db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
        .all() as { name: string }[]
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

  it('sets a 5s busy_timeout so co-firing cron writers wait out lock windows', () => {
    // scout and produce-next fire as separate processes on one SQLite file
    // (crontab co-fires them 3x/day); without this an overlapping write window
    // throws SQLITE_BUSY and crashes a run mid-flight.
    const db = openDb(tempDbPath())
    expect(db.pragma('busy_timeout', { simple: true })).toBe(5000)
    db.close()
  })
})
