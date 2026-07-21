import { describe, expect, it } from 'vitest'
import { openDb } from '../db/index.js'

describe('leases schema', () => {
  it('openDb creates the leases table with name as primary key', () => {
    const db = openDb(':memory:')
    const rows = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='leases'")
      .all()
    expect(rows).toHaveLength(1)
    db.prepare(
      "INSERT INTO leases (name, holder, expires_at) VALUES ('produce', 'pid:1', '2026-01-01T00:00:00.000Z')",
    ).run()
    // name is the primary key: a second row for the same lease is a conflict
    expect(() =>
      db
        .prepare(
          "INSERT INTO leases (name, holder, expires_at) VALUES ('produce', 'pid:2', '2026-01-01T00:00:00.000Z')",
        )
        .run(),
    ).toThrow(/UNIQUE constraint failed/)
    db.close()
  })
})
