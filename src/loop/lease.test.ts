import { describe, expect, it } from 'vitest'
import { openDb } from '../db/index.js'
import { acquireLease, PRODUCE_LEASE_TTL_MS, releaseLease } from './lease.js'

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

describe('acquireLease', () => {
  it('acquires a free lease and stamps holder + expiry exactly ttl ahead', () => {
    const db = openDb(':memory:')
    expect(PRODUCE_LEASE_TTL_MS).toBe(5_400_000)
    const before = Date.now()
    expect(acquireLease(db, 'produce', 'pid:100', PRODUCE_LEASE_TTL_MS)).toBe(true)
    const row = db
      .prepare("SELECT holder, expires_at FROM leases WHERE name = 'produce'")
      .get() as { holder: string; expires_at: string }
    expect(row.holder).toBe('pid:100')
    // expires_at = acquire-time + ttl, bounded by the wall clocks around the call
    const expires = Date.parse(row.expires_at)
    expect(expires).toBeGreaterThanOrEqual(before + PRODUCE_LEASE_TTL_MS)
    expect(expires).toBeLessThanOrEqual(Date.now() + PRODUCE_LEASE_TTL_MS)
    db.close()
  })

  it('refuses while the lease is held — even for the same holder', () => {
    const db = openDb(':memory:')
    expect(acquireLease(db, 'produce', 'pid:100', PRODUCE_LEASE_TTL_MS)).toBe(true)
    // a tick landing during a long render: the NORMAL no-op case
    expect(acquireLease(db, 'produce', 'pid:200', PRODUCE_LEASE_TTL_MS)).toBe(false)
    // acquire-if-free-or-expired has no same-holder re-entry
    expect(acquireLease(db, 'produce', 'pid:100', PRODUCE_LEASE_TTL_MS)).toBe(false)
    const row = db.prepare("SELECT holder FROM leases WHERE name = 'produce'").get() as {
      holder: string
    }
    expect(row.holder).toBe('pid:100')
    // a different lease name is independent
    expect(acquireLease(db, 'scout', 'pid:200', PRODUCE_LEASE_TTL_MS)).toBe(true)
    db.close()
  })

  it('takes over an expired lease, replacing the holder', () => {
    const db = openDb(':memory:')
    db.prepare(
      "INSERT INTO leases (name, holder, expires_at) VALUES ('produce', 'pid:dead', '2020-01-01T00:00:00.000Z')",
    ).run()
    expect(acquireLease(db, 'produce', 'pid:new', PRODUCE_LEASE_TTL_MS)).toBe(true)
    const row = db
      .prepare("SELECT holder, expires_at FROM leases WHERE name = 'produce'")
      .get() as { holder: string; expires_at: string }
    expect(row.holder).toBe('pid:new')
    expect(Date.parse(row.expires_at)).toBeGreaterThan(Date.now())
    db.close()
  })
})

describe('releaseLease', () => {
  it('deletes only when the holder matches', () => {
    const db = openDb(':memory:')
    acquireLease(db, 'produce', 'pid:100', PRODUCE_LEASE_TTL_MS)
    // wrong holder: no-op — the lease stays held
    releaseLease(db, 'produce', 'pid:999')
    expect(acquireLease(db, 'produce', 'pid:200', PRODUCE_LEASE_TTL_MS)).toBe(false)
    // right holder: freed for the next tick
    releaseLease(db, 'produce', 'pid:100')
    expect(acquireLease(db, 'produce', 'pid:200', PRODUCE_LEASE_TTL_MS)).toBe(true)
    db.close()
  })

  it('an evicted holder cannot release the takeover lease', () => {
    const db = openDb(':memory:')
    db.prepare(
      "INSERT INTO leases (name, holder, expires_at) VALUES ('produce', 'pid:dead', '2020-01-01T00:00:00.000Z')",
    ).run()
    acquireLease(db, 'produce', 'pid:new', PRODUCE_LEASE_TTL_MS)
    // the crashed process's finally-release fires late: must not free pid:new
    releaseLease(db, 'produce', 'pid:dead')
    const row = db.prepare("SELECT holder FROM leases WHERE name = 'produce'").get() as {
      holder: string
    }
    expect(row.holder).toBe('pid:new')
    db.close()
  })
})
