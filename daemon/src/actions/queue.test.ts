import { describe, expect, it } from 'vitest'
import { BrainrotError } from '../errors.js'
import { memDb, seedAction } from '../../testing/db.js'
import {
  completeAction,
  enqueueAction,
  failAction,
  failRunningActions,
  getAction,
  listRecentActions,
  pendingActions,
  setActionNotice,
  startAction,
} from './queue.js'

describe('operator action queue', () => {
  it('enqueues a row carrying the catalog lane, not a caller-supplied one', () => {
    const db = memDb()
    const id = enqueueAction(db, {
      kind: 'topics.reject',
      args: { ids: [3] },
      requestedBy: 'dashboard',
    })
    const row = getAction(db, id)
    expect(row?.kind).toBe('topics.reject')
    expect(row?.lane).toBe('fast')
    expect(row?.status).toBe('pending')
    expect(JSON.parse(row?.args ?? '{}')).toEqual({ ids: [3] })
  })

  it('returns pending rows for one lane only, oldest first', () => {
    const db = memDb()
    const a = seedAction(db, { lane: 'fast' })
    seedAction(db, { lane: 'slow', kind: 'produce' })
    const b = seedAction(db, { lane: 'fast' })
    seedAction(db, { lane: 'fast', status: 'done' })
    expect(pendingActions(db, 'fast', 10).map((r) => r.id)).toEqual([a, b])
  })

  it('honours the limit', () => {
    const db = memDb()
    seedAction(db)
    seedAction(db)
    seedAction(db)
    expect(pendingActions(db, 'fast', 2)).toHaveLength(2)
  })

  it('claims a pending row exactly once', () => {
    const db = memDb()
    const id = seedAction(db)
    const now = new Date('2026-08-01T10:00:00Z')
    expect(startAction(db, id, now)).toBe(true)
    // The guard IS the claim: a second caller loses rather than double-running.
    expect(startAction(db, id, now)).toBe(false)
    const row = getAction(db, id)
    expect(row?.status).toBe('running')
    expect(row?.startedAt).toBe(now.toISOString())
  })

  it('records a JSON result on completion', () => {
    const db = memDb()
    const id = seedAction(db)
    startAction(db, id, new Date('2026-08-01T10:00:00Z'))
    completeAction(db, id, { rejected: 2 }, new Date('2026-08-01T10:00:01Z'))
    const row = getAction(db, id)
    expect(row?.status).toBe('done')
    expect(JSON.parse(row?.result ?? 'null')).toEqual({ rejected: 2 })
    expect(row?.finishedAt).toBe('2026-08-01T10:00:01.000Z')
  })

  it('records the classified kind alongside the message on failure', () => {
    const db = memDb()
    const id = seedAction(db)
    startAction(db, id, new Date())
    failAction(
      db,
      id,
      new BrainrotError('no such job', { domain: 'job', kind: 'not-found' }),
      new Date(),
    )
    const row = getAction(db, id)
    expect(row?.status).toBe('failed')
    expect(row?.error).toBe('no such job')
    expect(row?.errorKind).toBe('not-found')
  })

  it('publishes a notice while the action is still running', () => {
    const db = memDb()
    const id = seedAction(db)
    startAction(db, id, new Date())
    setActionNotice(db, id, 'waiting for consent')
    expect(getAction(db, id)?.notice).toBe('waiting for consent')
    expect(getAction(db, id)?.status).toBe('running')
  })

  it('lists recent actions newest first', () => {
    const db = memDb()
    const a = seedAction(db)
    const b = seedAction(db)
    expect(listRecentActions(db, 10).map((r) => r.id)).toEqual([b, a])
  })

  it('fails every running row in its lane, and no other lane', () => {
    // Called once at worker start: within one daemon process, a 'running' row
    // at startup can only be from a dead process.
    const db = memDb()
    const stale = seedAction(db, { lane: 'fast', status: 'running' })
    const otherLane = seedAction(db, { lane: 'slow', kind: 'produce', status: 'running' })
    const pending = seedAction(db, { lane: 'fast', status: 'pending' })
    expect(failRunningActions(db, 'fast', new Date())).toBe(1)
    expect(getAction(db, stale)?.status).toBe('failed')
    expect(getAction(db, stale)?.errorKind).toBe('internal')
    expect(getAction(db, otherLane)?.status).toBe('running')
    expect(getAction(db, pending)?.status).toBe('pending')
  })

  it('returns null for an unknown id', () => {
    expect(getAction(memDb(), 999)).toBeNull()
  })

  it('preserves notice when an action fails, so the diagnostic survives', () => {
    const db = memDb()
    const id = enqueueAction(db, { kind: 'digest.run', args: {}, requestedBy: 'dashboard' })
    startAction(db, id, new Date())
    setActionNotice(db, id, 'job abc123')
    failAction(db, id, new Error('render died'), new Date())
    const row = getAction(db, id)
    expect(row?.status).toBe('failed')
    // The whole point: an interrupted render must stay traceable to its job.
    expect(row?.notice).toBe('job abc123')
  })

  it('preserves notice through the daemon-restart sweep', () => {
    const db = memDb()
    const id = enqueueAction(db, { kind: 'digest.run', args: {}, requestedBy: 'dashboard' })
    startAction(db, id, new Date())
    setActionNotice(db, id, 'job abc123')
    expect(failRunningActions(db, 'fast', new Date())).toBe(1)
    expect(getAction(db, id)?.notice).toBe('job abc123')
  })

  it('still clears notice on the claim and on success', () => {
    const db = memDb()
    const id = enqueueAction(db, { kind: 'digest.run', args: {}, requestedBy: 'dashboard' })
    setActionNotice(db, id, 'waiting for the produce lease')
    startAction(db, id, new Date())
    expect(getAction(db, id)?.notice).toBeNull()
    setActionNotice(db, id, 'in progress')
    completeAction(db, id, { ok: true }, new Date())
    expect(getAction(db, id)?.notice).toBeNull()
  })
})
