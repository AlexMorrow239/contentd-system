import { describe, expect, it } from 'vitest'
import { createDaemonWorkers, initializeDaemonWork } from '../daemon-workers.js'
import { requireLease } from '../lease.js'
import { readDaemonState } from '../daemon-state.js'
import { getAction } from '../../actions/queue.js'
import { memDb, seedAction, seedTopic } from '../../../testing/db.js'

describe('createDaemonWorkers', () => {
  it('constructs six inert units with only fast actions overriding the idle interval', async () => {
    const db = memDb()
    const topic = seedTopic(db)
    const id = seedAction(db, { kind: 'topics.reject', args: JSON.stringify({ ids: [topic] }) })
    const workers = createDaemonWorkers(db, { channelsDir: '/unused', runsRoot: '/unused' })
    expect(workers.map(({ name, idleSleepMs }) => [name, idleSleepMs])).toEqual([
      ['produce', undefined],
      ['scout', undefined],
      ['digest', undefined],
      ['actions-fast', 1000],
      ['actions-slow', undefined],
      ['cleanup', undefined],
    ])
    expect(getAction(db, id)?.status).toBe('pending')
    expect(readDaemonState(db)).toBeNull()
    expect(db.prepare('SELECT * FROM leases').all()).toEqual([])
    await workers[3].unit()
    expect(getAction(db, id)?.status).toBe('done')
    expect(readDaemonState(db)).not.toBeNull()
  })
})

describe('initializeDaemonWork', () => {
  it('reconciles abandoned actions directly under daemon ownership', () => {
    const db = memDb()
    const id = seedAction(db, { kind: 'topics.reject', status: 'running' })
    const owner = requireLease(db, 'daemon')
    try {
      initializeDaemonWork(db, owner)
      expect(getAction(db, id)?.status).toBe('failed')
    } finally {
      owner.release()
    }
  })
})
