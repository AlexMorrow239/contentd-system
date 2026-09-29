import { afterEach, describe, expect, it, vi } from 'vitest'
import { memDb } from '../../../testing/db.js'
import { acquireManagedLease, extendLease, leaseHolder, LeaseLostError } from '../lease.js'

afterEach(() => vi.useRealTimers())

describe('acquireManagedLease', () => {
  it('generates unique identities inside one process', () => {
    expect(leaseHolder()).not.toBe(leaseHolder())
    expect(leaseHolder('produce')).not.toBe(leaseHolder('produce'))
  })
  it('releases acquisition and parent listener when timer setup fails', () => {
    const db = memDb()
    const parent = acquireManagedLease(db, 'daemon')!
    const remove = vi.spyOn(parent.signal, 'removeEventListener')
    try {
      expect(() =>
        acquireManagedLease(db, 'produce', parent, {
          startInterval: () => {
            throw new Error('timer setup failed')
          },
        }),
      ).toThrow('timer setup failed')
      expect(db.prepare("SELECT * FROM leases WHERE name='produce'").all()).toEqual([])
      expect(remove).toHaveBeenCalledWith('abort', expect.any(Function))
    } finally {
      parent.release()
    }
  })

  it('renews through an injected callback and cancels before releasing ownership', () => {
    vi.useFakeTimers()
    const db = memDb()
    let heartbeat!: () => void
    let cancelled = 0
    const lease = acquireManagedLease(db, 'produce', undefined, {
      startInterval: (callback, ms) => {
        expect(ms).toBe(60_000)
        heartbeat = callback
        return () => {
          expect(db.prepare("SELECT holder FROM leases WHERE name='produce'").get()).toBeDefined()
          cancelled++
        }
      },
    })!
    const initial = Date.now()
    vi.setSystemTime(initial + 60_000)
    heartbeat()
    expect(db.prepare("SELECT expires_at FROM leases WHERE name='produce'").get()).toEqual({
      expires_at: new Date(initial + 360_000).toISOString(),
    })
    lease.release()
    lease.release()
    expect(cancelled).toBe(1)
    expect(db.prepare('SELECT * FROM leases').all()).toEqual([])
    expect(vi.getTimerCount()).toBe(0)
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
