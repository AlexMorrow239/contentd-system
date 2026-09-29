import { afterEach, describe, expect, it, vi } from 'vitest'
import { memDb } from '../../testing/db.js'
import { acquireManagedLease, extendLease, leaseHolder, LeaseLostError } from '../lease.js'

afterEach(() => vi.useRealTimers())

describe('acquireManagedLease', () => {
  it('generates unique identities inside one process', () => {
    expect(leaseHolder()).not.toBe(leaseHolder())
  })
  it('renews during long work and releases only its own token', () => {
    vi.useFakeTimers()
    const db = memDb()
    const lease = acquireManagedLease(db, 'produce')!
    const start = Date.now()
    vi.advanceTimersByTime(240_000)
    expect(db.prepare('SELECT expires_at FROM leases').get()).toEqual({
      expires_at: new Date(start + 540_000).toISOString(),
    })
    expect(acquireManagedLease(db, 'produce')).toBeNull()
    lease.release()
    expect(db.prepare('SELECT * FROM leases').all()).toHaveLength(0)
  })
  it('does not resurrect expired ownership or let stale release delete takeover', () => {
    vi.useFakeTimers()
    const db = memDb()
    const old = acquireManagedLease(db, 'produce')!
    vi.setSystemTime(Date.now() + 300_000)
    expect(extendLease(db, 'produce', old.token, 300_000)).toBe(false)
    const current = acquireManagedLease(db, 'produce')!
    expect(() => old.assertOwned()).toThrow(LeaseLostError)
    expect(old.signal.aborted).toBe(true)
    old.release()
    current.assertOwned()
    current.release()
  })
  it('aborts if renewal throws instead of escaping from the timer', () => {
    vi.useFakeTimers()
    const db = memDb()
    const lease = acquireManagedLease(db, 'scout')!
    db.exec('DROP TABLE leases')
    expect(() => vi.advanceTimersByTime(60_000)).not.toThrow()
    expect(lease.signal.aborted).toBe(true)
    expect(() => lease.assertOwned()).toThrow(LeaseLostError)
    lease.release()
  })
})
