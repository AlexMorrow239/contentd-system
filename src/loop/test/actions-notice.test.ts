import { describe, expect, it } from 'vitest'
import { enqueueAction, getAction } from '../../actions/queue.js'
import { fileDb } from '../../testing/db.js'
import { actionsUnit } from '../actions-worker.js'

describe('ActionContext.setNotice through the worker', () => {
  it("lands a running handler's notice on the row while it runs", async () => {
    const { db } = fileDb()
    const id = enqueueAction(db, {
      kind: 'library.backfillStore',
      args: {},
      requestedBy: 'dashboard',
    })
    let seenMidRun: string | null = null
    const unit = actionsUnit(db, 'slow', {
      channelsDir: '/ch',
      runsRoot: '/runs',
      run: (ctx) => {
        ctx.setNotice('uploaded 1/2')
        // Read it back on a DIFFERENT statement, proving it reached the row
        // rather than only the closure.
        seenMidRun = getAction(db, id)?.notice ?? null
        return Promise.resolve({ uploaded: 0 })
      },
    })
    await unit()
    expect(seenMidRun).toBe('uploaded 1/2')
    // Cleared on success — a stale progress label must not outlive the run.
    expect(getAction(db, id)?.notice).toBeNull()
  })

  it('leaves the last notice in place when the handler throws', async () => {
    const { db } = fileDb()
    const id = enqueueAction(db, {
      kind: 'library.backfillStore',
      args: {},
      requestedBy: 'dashboard',
    })
    const unit = actionsUnit(db, 'slow', {
      channelsDir: '/ch',
      runsRoot: '/runs',
      run: (ctx) => {
        // Write the notice BEFORE throwing — this is the interrupted-render
        // shape: the handler published its context and then died.
        ctx.setNotice('uploaded 1/2')
        return Promise.reject(new Error('bucket said no'))
      },
    })
    await unit()
    const row = getAction(db, id)
    expect(row?.status).toBe('failed')
    expect(row?.notice).toBe('uploaded 1/2')
  })
})
