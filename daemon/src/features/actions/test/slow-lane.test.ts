import { describe, expect, it, vi } from 'vitest'
import { fileDb } from '../../../../testing/db.js'
import { acquireLease, releaseLease } from '../../../infra/coordination/lease.js'
import { enqueueAction, getAction } from '../queue.js'
import { actionsUnit } from '../worker.js'

describe('the slow action lane', () => {
  it('waits for a held lease, explains itself, then runs when it frees', async () => {
    // fileDb() returns { db, dbPath, root }, not a bare Database — the brief's
    // `const db = fileDb()` doesn't compile against the real helper.
    const { db } = fileDb()
    const id = enqueueAction(db, {
      kind: 'jobs.resume',
      args: { jobId: 'j1' },
      requestedBy: 'dashboard',
    })
    const run = vi.fn().mockResolvedValue({ jobId: 'j1', status: 'ready' })
    const unit = actionsUnit(db, 'slow', { channelsDir: '/ch', runsRoot: '/runs', run })

    // The daemon's own produce worker is mid-render.
    expect(acquireLease(db, 'produce', 'pid:daemon', 60_000)).toBe(true)

    const blocked = await unit()
    expect(blocked).toEqual({
      worked: false,
      line: { action: 'noop', reason: 'lease-held', lease: 'produce' },
    })
    const waiting = getAction(db, id)
    expect(waiting?.status).toBe('pending')
    expect(waiting?.notice).toBe('waiting for the produce lease')
    expect(run).not.toHaveBeenCalled()

    // The render finishes.
    releaseLease(db, 'produce', 'pid:daemon')

    const worked = await unit()
    expect(worked.worked).toBe(true)
    const settled = getAction(db, id)
    expect(settled?.status).toBe('done')
    expect(settled?.result).toBe(JSON.stringify({ jobId: 'j1', status: 'ready' }))
    // The notice is cleared by the claim, not left as a stale "waiting" label.
    expect(settled?.notice).toBeNull()
    // And the lease it borrowed is handed back.
    expect(db.prepare('SELECT COUNT(*) AS n FROM leases').get()).toEqual({ n: 0 })
  })

  it('records a failed-status JobResult as done, with the result preserved verbatim', async () => {
    // executeOne passes `await deps.run(...)` straight into completeAction —
    // a JobResult carrying `status: 'failed'` is not itself a thrown error,
    // so the row still lands 'done' with the tick's own result intact. No
    // test anywhere else covers this, and it's the property CLAUDE.md's
    // "Two slow-handler behaviours" paragraph calls load-bearing.
    const { db } = fileDb()
    const id = enqueueAction(db, {
      kind: 'jobs.resume',
      args: { jobId: 'j1' },
      requestedBy: 'dashboard',
    })
    const run = vi.fn().mockResolvedValue({ jobId: 'j1', status: 'failed' })
    const unit = actionsUnit(db, 'slow', { channelsDir: '/ch', runsRoot: '/runs', run })

    const worked = await unit()
    expect(worked.worked).toBe(true)
    const settled = getAction(db, id)
    expect(settled?.status).toBe('done')
    expect(settled?.result).toBe(JSON.stringify({ jobId: 'j1', status: 'failed' }))
  })
})
