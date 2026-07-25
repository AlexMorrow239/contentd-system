import { afterEach, describe, expect, it, vi } from 'vitest'
import { openDb } from '../db/index.js'
import {
  acquireLease,
  extendLease,
  PRODUCE_LEASE_TTL_MS,
  PUBLISH_LEASE_TTL_MS,
  releaseLease,
} from './lease.js'

// Only the boundary test fakes the clock; restoring here keeps a failing
// assertion inside it from leaking a frozen clock into the rest of the file.
afterEach(() => {
  vi.useRealTimers()
})

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

  // The guard is strictly-greater (lease.ts): expires_at exactly equal to the
  // acquire instant is already expired. Frozen clock, because the boundary is
  // the one instant the wall clock cannot be made to land on.
  it('treats an expiry equal to the acquire instant as expired, one millisecond later as held', () => {
    const db = openDb(':memory:')
    const now = new Date('2026-07-20T12:00:00.000Z')
    vi.useFakeTimers()
    vi.setSystemTime(now)
    const insert = db.prepare('INSERT INTO leases (name, holder, expires_at) VALUES (?, ?, ?)')
    insert.run('produce', 'pid:dead', now.toISOString())
    insert.run('publish', 'pid:live', new Date(now.getTime() + 1).toISOString())

    expect(acquireLease(db, 'produce', 'pid:new', PRODUCE_LEASE_TTL_MS)).toBe(true)
    expect(acquireLease(db, 'publish', 'pid:new', PUBLISH_LEASE_TTL_MS)).toBe(false)
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

describe('extendLease', () => {
  it('pushes the expiry a fresh ttl ahead for the holding process', () => {
    const db = openDb(':memory:')
    acquireLease(db, 'produce', 'pid:100', PRODUCE_LEASE_TTL_MS)
    // A drifted expiry stands in for a render that outlived its lease.
    db.prepare("UPDATE leases SET expires_at = '2020-01-01T00:00:00.000Z' WHERE name = 'produce'").run()
    const before = Date.now()
    expect(extendLease(db, 'produce', 'pid:100', PRODUCE_LEASE_TTL_MS)).toBe(true)
    const row = db
      .prepare("SELECT holder, expires_at FROM leases WHERE name = 'produce'")
      .get() as { holder: string; expires_at: string }
    expect(row.holder).toBe('pid:100')
    expect(Date.parse(row.expires_at)).toBeGreaterThanOrEqual(before + PRODUCE_LEASE_TTL_MS)
    db.close()
  })

  it('refuses when the holder differs — a lost lease is never re-acquired', () => {
    const db = openDb(':memory:')
    acquireLease(db, 'produce', 'pid:new', PRODUCE_LEASE_TTL_MS)
    // The evicted holder's heartbeat fires late: it must neither extend nor
    // steal back the lease the takeover process now owns.
    expect(extendLease(db, 'produce', 'pid:dead', PRODUCE_LEASE_TTL_MS)).toBe(false)
    const row = db.prepare("SELECT holder FROM leases WHERE name = 'produce'").get() as {
      holder: string
    }
    expect(row.holder).toBe('pid:new')
    db.close()
  })

  it('refuses when the lease row is gone', () => {
    const db = openDb(':memory:')
    expect(extendLease(db, 'produce', 'pid:100', PRODUCE_LEASE_TTL_MS)).toBe(false)
    expect(db.prepare("SELECT COUNT(*) AS n FROM leases").get()).toEqual({ n: 0 })
    db.close()
  })
})

describe('PUBLISH_LEASE_TTL_MS', () => {
  it('is 30 minutes — a much shorter window than produce, one upload per tick', () => {
    expect(PUBLISH_LEASE_TTL_MS).toBe(1_800_000)
  })
})
