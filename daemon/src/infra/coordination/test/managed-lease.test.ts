import { describe, expect, it, vi } from 'vitest'
import { memDb } from '../../../../testing/db.js'
import { createTestTime } from '../../../../testing/time.js'
import { LeaseLostError, acquireManagedLease, extendLease, leaseHolder } from '../lease.js'

describe('acquireManagedLease', () => {
  it('generates unique identities inside one process', () => {
    expect(leaseHolder()).not.toBe(leaseHolder())
    expect(leaseHolder('produce')).not.toBe(leaseHolder('produce'))
  })
  it('rejects conflicting clocks before acquiring a child lease', () => {
    const time = createTestTime(0)
    const db = memDb(time)
    const parent = acquireManagedLease(db, 'daemon', undefined, { time })!
    expect(() => acquireManagedLease(db, 'produce', parent, { time: createTestTime(0) })).toThrow(
      'conflicting time sources',
    )
    expect(db.prepare("SELECT * FROM leases WHERE name='produce'").all()).toEqual([])
    parent.release()
    expect(time.pendingTimerCount()).toBe(0)
  })
  it('releases acquisition and parent listener when timer setup fails', () => {
    const time = createTestTime(0)
    const db = memDb(time)
    const parent = acquireManagedLease(db, 'daemon', undefined, { time })!
    const remove = vi.spyOn(parent.signal, 'removeEventListener')
    vi.spyOn(time, 'startInterval').mockImplementationOnce(() => {
      throw new Error('timer setup failed')
    })
    expect(() => acquireManagedLease(db, 'produce', parent)).toThrow('timer setup failed')
    expect(db.prepare("SELECT * FROM leases WHERE name='produce'").all()).toEqual([])
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function))
    parent.release()
    expect(time.pendingTimerCount()).toBe(0)
  })
  it('renews throughout long work and cleans up idempotently', async () => {
    const time = createTestTime(0)
    const db = memDb(time)
    const lease = acquireManagedLease(db, 'produce', undefined, { time })!
    await time.advanceBy(240_000)
    expect(db.prepare('SELECT expires_at FROM leases').get()).toEqual({
      expires_at: '1970-01-01T00:09:00.000Z',
    })
    expect(acquireManagedLease(db, 'produce', undefined, { time })).toBeNull()
    lease.release()
    lease.release()
    expect(db.prepare('SELECT * FROM leases').all()).toEqual([])
    expect(time.pendingTimerCount()).toBe(0)
  })
  it('does not resurrect expired ownership or let stale release delete takeover', () => {
    const time = createTestTime(0)
    const db = memDb(time)
    const old = acquireManagedLease(db, 'produce', undefined, { time })!
    time.setNow(300_000)
    expect(extendLease(db, 'produce', old.token, 300_000, time)).toBe(false)
    const current = acquireManagedLease(db, 'produce', undefined, { time })!
    expect(() => old.assertOwned()).toThrow(LeaseLostError)
    expect(old.signal.aborted).toBe(true)
    old.release()
    current.assertOwned()
    current.release()
    expect(time.pendingTimerCount()).toBe(0)
  })
  it('aborts if renewal throws instead of escaping from the timer', async () => {
    const time = createTestTime(0)
    const db = memDb(time)
    const lease = acquireManagedLease(db, 'scout', undefined, { time })!
    db.exec('DROP TABLE leases')
    await time.advanceBy(60_000)
    expect(lease.signal.aborted).toBe(true)
    expect(() => lease.assertOwned()).toThrow(LeaseLostError)
    lease.release()
    expect(time.pendingTimerCount()).toBe(0)
  })
})
