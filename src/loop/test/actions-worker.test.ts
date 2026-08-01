import { describe, expect, it, vi } from 'vitest'
import type { Database } from 'better-sqlite3'
import { getAction } from '../../actions/queue.js'
import { memDb, seedAction, seedJob, seedTopic } from '../../testing/db.js'
import { acquireLease } from '../lease.js'
import { readDaemonState } from '../daemon-state.js'
import type { UnitResult } from '../daemon.js'
import { actionsUnit } from '../actions-worker.js'

function unit(db: Database, lane: 'fast' | 'slow' = 'fast'): () => Promise<UnitResult> {
  return actionsUnit(db, lane, {
    channelsDir: '/nonexistent/channels',
    runsRoot: '/nonexistent/runs',
    now: () => new Date('2026-08-01T10:00:00Z'),
  })
}

describe('actionsUnit', () => {
  it('is silently idle on an empty queue', async () => {
    // A 1s poll must emit a STABLE idle line (or none) or runWorker's dedupe
    // cannot suppress it, and a quiet night becomes 86,400 log lines.
    const result = await unit(memDb())()
    expect(result).toEqual({ worked: false })
  })

  it('executes a pending fast action and records its result', async () => {
    const db = memDb()
    const topic = seedTopic(db)
    const id = seedAction(db, { kind: 'topics.reject', args: JSON.stringify({ ids: [topic] }) })
    const result = await unit(db)()
    expect(result.worked).toBe(true)
    const row = getAction(db, id)
    expect(row?.status).toBe('done')
    expect(JSON.parse(row?.result ?? '{}')).toEqual({ rejected: 1, requested: 1 })
  })

  it('drains several fast actions in one poll', async () => {
    const db = memDb()
    const a = seedTopic(db, { title: 'a' })
    const b = seedTopic(db, { title: 'b' })
    const first = seedAction(db, { kind: 'topics.reject', args: JSON.stringify({ ids: [a] }) })
    const second = seedAction(db, { kind: 'topics.reject', args: JSON.stringify({ ids: [b] }) })
    await unit(db)()
    expect(getAction(db, first)?.status).toBe('done')
    expect(getAction(db, second)?.status).toBe('done')
  })

  it('records a handler failure without taking the worker down', async () => {
    const db = memDb()
    seedJob(db, 'j1')
    const id = seedAction(db, {
      kind: 'publish.retry',
      args: JSON.stringify({ jobId: 'j1' }),
    })
    await expect(unit(db)()).resolves.toBeDefined()
    const row = getAction(db, id)
    expect(row?.status).toBe('failed')
    expect(row?.error).toContain('no interrupted publish')
    expect(row?.errorKind).toBe('not-found')
  })

  it('leaves a lease-blocked action pending and explains the wait', async () => {
    const db = memDb()
    acquireLease(db, 'publish', 'someone-else', 60_000)
    const id = seedAction(db, { kind: 'publish.retry', args: JSON.stringify({ jobId: 'j1' }) })
    const result = await unit(db)()
    expect(result.worked).toBe(false)
    expect(getAction(db, id)?.status).toBe('pending')
    expect(getAction(db, id)?.notice).toBe('waiting for the publish lease')
  })

  it('skips past a lease-blocked action to one that can run', async () => {
    // Otherwise a long upload holding the publish lease stalls every trivial
    // row mutation queued behind it — head-of-line blocking the lanes exist
    // to avoid.
    const db = memDb()
    acquireLease(db, 'publish', 'someone-else', 60_000)
    const blocked = seedAction(db, { kind: 'publish.retry', args: JSON.stringify({ jobId: 'j1' }) })
    const topic = seedTopic(db)
    const runnable = seedAction(db, {
      kind: 'topics.reject',
      args: JSON.stringify({ ids: [topic] }),
    })
    await unit(db)()
    expect(getAction(db, blocked)?.status).toBe('pending')
    expect(getAction(db, runnable)?.status).toBe('done')
  })

  it('releases the lease it took', async () => {
    const db = memDb()
    seedJob(db, 'j1')
    seedAction(db, { kind: 'publish.retry', args: JSON.stringify({ jobId: 'j1' }) })
    await unit(db)()
    // A lease left held would wedge the publish worker for its whole TTL.
    expect(acquireLease(db, 'publish', 'next-caller', 1_000)).toBe(true)
  })

  it('fails rows left running by a dead daemon, once, on the first poll', async () => {
    const db = memDb()
    const stale = seedAction(db, { status: 'running' })
    const tick = unit(db)
    await tick()
    expect(getAction(db, stale)?.status).toBe('failed')
    expect(getAction(db, stale)?.error).toContain('daemon restart')
    // A row that starts running AFTER the sweep must survive the next poll.
    const live = seedAction(db, { status: 'running' })
    await tick()
    expect(getAction(db, live)?.status).toBe('running')
  })

  it('takes only its own lane', async () => {
    const db = memDb()
    const slow = seedAction(db, { lane: 'slow', kind: 'produce' })
    await unit(db, 'fast')()
    expect(getAction(db, slow)?.status).toBe('pending')
  })

  it('stamps the daemon heartbeat from the fast lane only', async () => {
    const db = memDb()
    await unit(db, 'fast')()
    expect(readDaemonState(db)?.pid).toBe(process.pid)

    const other = memDb()
    await unit(other, 'slow')()
    expect(readDaemonState(other)).toBeNull()
  })

  it('throttles the heartbeat rather than writing every poll', async () => {
    const db = memDb()
    const clock = vi.fn<() => Date>()
    clock
      .mockReturnValueOnce(new Date('2026-08-01T10:00:00Z'))
      .mockReturnValueOnce(new Date('2026-08-01T10:00:01Z'))
      .mockReturnValue(new Date('2026-08-01T10:00:20Z'))
    const tick = actionsUnit(db, 'fast', {
      channelsDir: '/nonexistent',
      runsRoot: '/nonexistent',
      now: clock,
    })
    await tick()
    await tick()
    expect(readDaemonState(db)?.lastSeenAt).toBe('2026-08-01T10:00:00.000Z')
    await tick()
    expect(readDaemonState(db)?.lastSeenAt).toBe('2026-08-01T10:00:20.000Z')
  })
})
