import { describe, expect, it } from 'vitest'
import { memDb } from '../../../../testing/db.js'
import { produceUnit } from '../worker.js'

describe('produceUnit', () => {
  it('maps a noop tick to idle with the tick line', async () => {
    const db = memDb()
    const unit = produceUnit(db, {
      channelsDir: '/nowhere',
      runsRoot: '/nowhere',
      tick: async () => ({ action: 'noop', reason: 'no-eligible-work' }),
    })
    expect(await unit()).toEqual({
      worked: false,
      line: { action: 'noop', reason: 'no-eligible-work' },
    })
  })

  it('maps a produced tick to worked', async () => {
    const db = memDb()
    const unit = produceUnit(db, {
      channelsDir: '/nowhere',
      runsRoot: '/nowhere',
      tick: async () => ({ action: 'produced', jobId: 'j1', status: 'ready' }),
    })
    expect((await unit()).worked).toBe(true)
  })

  it('passes the configured dirs through to the tick', async () => {
    const db = memDb()
    const seen: { channelsDir?: string; runsRoot?: string } = {}
    const unit = produceUnit(db, {
      channelsDir: '/chans',
      runsRoot: '/runs',
      tick: async (_db, opts) => {
        seen.channelsDir = opts.channelsDir
        seen.runsRoot = opts.runsRoot
        return { action: 'noop', reason: 'no-eligible-work' }
      },
    })
    await unit()
    expect(seen).toEqual({ channelsDir: '/chans', runsRoot: '/runs' })
  })
})
