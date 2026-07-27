import { describe, expect, it } from 'vitest'
import { openDb } from './index.js'

describe('publishes and oauth_tokens tables', () => {
  it('are created by openDb', () => {
    const db = openDb(':memory:')
    const names = (
      db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as {
        name: string
      }[]
    ).map((r) => r.name)
    expect(names).toContain('publishes')
    expect(names).toContain('oauth_tokens')
    db.close()
  })
})

describe('publishes table constraints', () => {
  it('rejects a status outside the lifecycle CHECK', () => {
    const db = openDb(':memory:')
    expect(() =>
      db
        .prepare(
          'INSERT INTO publishes (job_id, platform, channel, day, seq, status, attempt) ' +
            "VALUES ('job-1', 'youtube', 'chan-a', '2026-07-22', 1, 'uploading', 1)",
        )
        .run(),
    ).toThrow(/CHECK/)
    db.close()
  })

  it('rejects a duplicate (channel, platform, day, seq) insert', () => {
    const db = openDb(':memory:')
    db.prepare(
      'INSERT INTO publishes (job_id, platform, channel, day, seq, status, attempt) ' +
        "VALUES ('job-1', 'youtube', 'chan-a', '2026-07-22', 1, 'claimed', 1)",
    ).run()
    expect(() =>
      db
        .prepare(
          'INSERT INTO publishes (job_id, platform, channel, day, seq, status, attempt) ' +
            "VALUES ('job-2', 'youtube', 'chan-a', '2026-07-22', 1, 'claimed', 1)",
        )
        .run(),
    ).toThrow(/UNIQUE/)
    db.close()
  })

  it('rejects an error_kind outside the CHECK, and accepts NULL', () => {
    const db = openDb(':memory:')
    expect(() =>
      db
        .prepare(
          'INSERT INTO publishes (job_id, platform, channel, day, seq, status, error_kind, attempt) ' +
            "VALUES ('job-1', 'youtube', 'chan-a', '2026-07-22', 1, 'failed', 'timeout', 1)",
        )
        .run(),
    ).toThrow(/CHECK/)
    db.prepare(
      'INSERT INTO publishes (job_id, platform, channel, day, seq, status, error_kind, attempt) ' +
        "VALUES ('job-1', 'youtube', 'chan-a', '2026-07-22', 1, 'claimed', NULL, 1)",
    ).run()
    const row = db.prepare('SELECT error_kind FROM publishes').get() as {
      error_kind: string | null
    }
    expect(row.error_kind).toBeNull()
    db.close()
  })
})
