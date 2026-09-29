import { beforeEach } from 'vitest'
import { createTestTime, type TestTime } from '../../../testing/time.js'
let time: TestTime
beforeEach(() => {
  time = createTestTime(new Date('2026-08-01T12:00:00Z'))
})
import { describe, expect, it, vi } from 'vitest'
import type { Database } from 'better-sqlite3'
import { getAction } from '../../actions/queue.js'
import { memDb, seedAction, seedJob, seedTopic } from '../../../testing/db.js'
import { acquireLease, LeaseLostError, requireLease } from '../lease.js'
import { linkActionJob } from '../../jobs/execution.js'
import { readDaemonState } from '../daemon-state.js'
import type { UnitResult } from '../worker-contract.js'
import {
  actionsUnit,
  MAX_FAST_DRAIN,
  SLOW_ACTION_HEARTBEAT_MS,
  SLOW_ACTION_LEASE_TTL_MS,
} from '../actions-worker.js'

function unit(db: Database, lane: 'fast' | 'slow' = 'fast'): () => Promise<UnitResult> {
  return actionsUnit(db, lane, {
    time,
    channelsDir: '/nonexistent/channels',
    runsRoot: '/nonexistent/runs',
  })
}

function leaseExpiry(db: Database, name: string): string {
  const row = db.prepare('SELECT expires_at FROM leases WHERE name = ?').get(name) as
    { expires_at: string } | undefined
  return row?.expires_at ?? ''
}

describe('actionsUnit', () => {
  it('uses the supplied process identity for the heartbeat', async () => {
    const db = memDb(time)
    await actionsUnit(db, 'fast', {
      time,
      channelsDir: '/unused',
      runsRoot: '/unused',
      pid: 1234,
    })()
    expect(readDaemonState(db)?.pid).toBe(1234)
  })

  it.each(['success', 'failure', 'malformed', 'lost-claim'] as const)(
    'cancels the injected interval and releases the lease after %s',
    async (outcome) => {
      const db = memDb(time)
      const id = seedAction(db, {
        kind: 'scout.run',
        lane: 'slow',
        args: outcome === 'malformed' ? '{' : '{}',
      })
      let cancelled = 0
      let handlerCalls = 0
      const startInterval = time.startInterval
      vi.spyOn(time, 'startInterval').mockImplementation((callback, ms) => {
        const cancel = startInterval(callback, ms)
        if (outcome === 'lost-claim')
          db.prepare("UPDATE operator_actions SET status='running' WHERE id=?").run(id)
        return () => {
          expect(db.prepare("SELECT holder FROM leases WHERE name='scout'").get()).toBeDefined()
          cancel()
          cancelled++
        }
      })
      await actionsUnit(db, 'slow', {
        time,
        channelsDir: '/unused',
        runsRoot: '/unused',
        run: async () => {
          handlerCalls++
          if (outcome === 'failure') throw new Error('handler failed')
          return { ok: true }
        },
      })()
      expect(cancelled).toBe(1)
      expect(handlerCalls).toBe(outcome === 'malformed' || outcome === 'lost-claim' ? 0 : 1)
      expect(getAction(db, id)?.status).toBe(
        outcome === 'success' ? 'done' : outcome === 'lost-claim' ? 'running' : 'failed',
      )
      expect(db.prepare('SELECT * FROM leases').all()).toEqual([])
    },
  )

  it('keeps an action pending when interval setup fails and releases its lease', async () => {
    const db = memDb(time)
    const id = seedAction(db, { kind: 'scout.run', lane: 'slow', args: '{}' })
    vi.spyOn(time, 'startInterval').mockImplementationOnce(() => {
      throw new Error('interval unavailable')
    })
    await expect(
      actionsUnit(db, 'slow', { time, channelsDir: '/unused', runsRoot: '/unused' })(),
    ).rejects.toThrow('interval unavailable')
    expect(getAction(db, id)?.status).toBe('pending')
    expect(db.prepare('SELECT * FROM leases').all()).toEqual([])
  })

  it('is silently idle on an empty queue', async () => {
    // A 1s poll must emit a STABLE idle line (or none) or runWorker's dedupe
    // cannot suppress it, and a quiet night becomes 86,400 log lines.
    const result = await unit(memDb(time))()
    expect(result).toEqual({ worked: false })
  })

  it('executes a pending fast action and records its result', async () => {
    const db = memDb(time)
    const topic = seedTopic(db)
    const id = seedAction(db, { kind: 'topics.reject', args: JSON.stringify({ ids: [topic] }) })
    const result = await unit(db)()
    expect(result.worked).toBe(true)
    const row = getAction(db, id)
    expect(row?.status).toBe('done')
    expect(JSON.parse(row?.result ?? '{}')).toEqual({ rejected: 1, requested: 1 })
  })

  it('drains several fast actions in one poll', async () => {
    const db = memDb(time)
    const a = seedTopic(db, { title: 'a' })
    const b = seedTopic(db, { title: 'b' })
    const first = seedAction(db, { kind: 'topics.reject', args: JSON.stringify({ ids: [a] }) })
    const second = seedAction(db, { kind: 'topics.reject', args: JSON.stringify({ ids: [b] }) })
    await unit(db)()
    expect(getAction(db, first)?.status).toBe('done')
    expect(getAction(db, second)?.status).toBe('done')
  })

  it('records a handler failure without taking the worker down', async () => {
    const db = memDb(time)
    // A candidate topic (the seedTopic default) is not claimed — requeueTopic
    // refuses it, which is a real handler throw this test can observe without
    // stubbing anything.
    const topic = seedTopic(db)
    const id = seedAction(db, { kind: 'topics.requeue', args: JSON.stringify({ id: topic }) })
    await expect(unit(db)()).resolves.toBeDefined()
    const row = getAction(db, id)
    expect(row?.status).toBe('failed')
    expect(row?.error).toContain('not requeued')
    expect(row?.errorKind).toBe('refused')
  })

  // The next four tests seed `kind: 'scout.run'` (lease: 'scout') onto the
  // FAST lane. `lane` is a plain column the worker filters rows on, while the
  // LEASE it takes comes from the catalog entry for `kind` — so this exercises
  // the fast lane's generic lease-blocking mechanism (skip-set, notice, short
  // TTL) using a kind that is really slow-lane-registered, because no
  // fast-lane action declares a lease of its own. Do not "fix" this to a
  // fast-registered kind — there isn't one.

  it('leaves a lease-blocked action pending and explains the wait', async () => {
    const db = memDb(time)
    acquireLease(db, 'scout', 'someone-else', 60_000, time)
    const id = seedAction(db, { kind: 'scout.run', args: '{}' })
    const result = await unit(db)()
    expect(result.worked).toBe(false)
    expect(getAction(db, id)?.status).toBe('pending')
    expect(getAction(db, id)?.notice).toBe('waiting for the scout lease')
  })

  it('skips past a lease-blocked action to one that can run', async () => {
    // Otherwise a long-running action holding a lease stalls every trivial
    // row mutation queued behind it — head-of-line blocking the lanes exist
    // to avoid.
    const db = memDb(time)
    acquireLease(db, 'scout', 'someone-else', 60_000, time)
    const blocked = seedAction(db, { kind: 'scout.run', args: '{}' })
    const topic = seedTopic(db)
    const runnable = seedAction(db, {
      kind: 'topics.reject',
      args: JSON.stringify({ ids: [topic] }),
    })
    await unit(db)()
    expect(getAction(db, blocked)?.status).toBe('pending')
    expect(getAction(db, runnable)?.status).toBe('done')
  })

  it('attempts a held lease once per poll, skipping later rows that need it', async () => {
    const db = memDb(time)
    seedAction(db, { kind: 'scout.run', lane: 'fast', args: '{}' })
    seedAction(db, { kind: 'scout.run', lane: 'fast', args: '{}' })
    seedAction(db, { kind: 'scout.run', lane: 'fast', args: '{}' })
    // Someone else holds it for the whole poll.
    expect(acquireLease(db, 'scout', 'pid:other', 60_000, time)).toBe(true)

    const result = await unit(db)()

    expect(result).toEqual({
      worked: false,
      line: { action: 'noop', reason: 'lease-held', lease: 'scout' },
    })
    const notices = db.prepare('SELECT notice FROM operator_actions ORDER BY id ASC').all() as {
      notice: string | null
    }[]
    // Only the FIRST blocked row is touched: the rest are skipped before any
    // acquire attempt, so they never get a notice written.
    expect(notices.map((r) => r.notice)).toEqual(['waiting for the scout lease', null, null])
    // All three are still pending — skipping is not failing.
    const statuses = db.prepare('SELECT status FROM operator_actions ORDER BY id ASC').all() as {
      status: string
    }[]
    expect(statuses.map((r) => r.status)).toEqual(['pending', 'pending', 'pending'])
  })

  it('releases the lease it took', async () => {
    const db = memDb(time)
    // channelsDir is '/nonexistent/channels' (see `unit`), so scout.run's
    // handler folds the load failure into a benign noop rather than throwing
    // — this test only cares that the lease is freed either way.
    seedAction(db, { kind: 'scout.run', args: '{}' })
    await unit(db)()
    // A lease left held would wedge the scout worker for its whole TTL.
    expect(acquireLease(db, 'scout', 'next-caller', 1_000, time)).toBe(true)
  })

  it('leaves running rows for daemon-owned startup reconciliation', async () => {
    const db = memDb(time)
    const stale = seedAction(db, { status: 'running' })
    const tick = unit(db)
    await tick()
    expect(getAction(db, stale)?.status).toBe('running')
    // Lane startup cannot classify ownership or repair another worker's rows.
    const live = seedAction(db, { status: 'running' })
    await tick()
    expect(getAction(db, live)?.status).toBe('running')
  })

  it.each(['scout.run', 'jobs.produce'] as const)(
    'reconciles %s after child ownership is lost while the daemon remains live',
    async (kind) => {
      const db = memDb(time)
      const daemonLease = requireLease(db, 'daemon', undefined, { time })
      const id = seedAction(db, { kind, lane: 'slow', args: '{}' })
      const jobId =
        kind === 'jobs.produce' ? seedJob(db, 'interrupted-render', { status: 'running' }) : null
      const operation = kind === 'scout.run' ? 'scout' : 'produce'
      const tick = actionsUnit(db, 'slow', {
        time,
        channelsDir: '/unused',
        runsRoot: '/unused',
        daemonLease,
        run: async (ctx) => {
          if (jobId) linkActionJob(db, id, jobId, daemonLease)
          db.prepare('UPDATE leases SET expires_at = ? WHERE name = ?').run(
            '2000-01-01T00:00:00Z',
            operation,
          )
          expect(acquireLease(db, operation, 'successor-operation', 300_000, time)).toBe(true)
          ctx.lease!.assertOwned()
        },
      })
      try {
        // The worker may surface the ownership error; its action still needs
        // reconciliation by the current daemon before the next idle poll.
        await tick().catch((err: unknown) => {
          expect(err).toBeInstanceOf(LeaseLostError)
        })
        daemonLease.assertOwned()
        const action = getAction(db, id)
        expect(action).toMatchObject({ status: 'failed', jobId })
        expect(action?.error).toMatch(/interrupt|ownership|lease/i)
        if (jobId) {
          expect(action?.notice).toContain(jobId)
          expect(db.prepare('SELECT status FROM jobs WHERE id = ?').get(jobId)).toEqual({
            status: 'running',
          })
        }
        expect(db.prepare('SELECT holder FROM leases WHERE name = ?').get(operation)).toEqual({
          holder: 'successor-operation',
        })
        expect(await tick()).toEqual({ worked: false })
      } finally {
        daemonLease.release()
      }
    },
  )

  it('takes only its own lane', async () => {
    const db = memDb(time)
    const slow = seedAction(db, { lane: 'slow', kind: 'produce' })
    await unit(db, 'fast')()
    expect(getAction(db, slow)?.status).toBe('pending')
  })

  it('stamps the daemon heartbeat from the fast lane only', async () => {
    const db = memDb(time)
    await unit(db, 'fast')()
    expect(readDaemonState(db)?.pid).toBe(process.pid)

    const other = memDb(time)
    await unit(other, 'slow')()
    expect(readDaemonState(other)).toBeNull()
  })

  it('throttles the heartbeat rather than writing every poll', async () => {
    const db = memDb(time)
    time.setNow(new Date('2026-08-01T10:00:00Z'))
    const tick = actionsUnit(db, 'fast', {
      time,
      channelsDir: '/nonexistent',
      runsRoot: '/nonexistent',
    })
    await tick()
    await time.advanceBy(1_000)
    await tick()
    expect(readDaemonState(db)?.lastSeenAt).toBe('2026-08-01T10:00:00.000Z')
    await time.advanceBy(19_000)
    await tick()
    expect(readDaemonState(db)?.lastSeenAt).toBe('2026-08-01T10:00:20.000Z')
  })

  it('threads the clock per row so a slow action records real elapsed time, not poll skew', async () => {
    // A single frozen Date per poll would stamp started_at === finished_at
    // for an action taking minutes. Advance the shared source during the
    // handler and assert that completion reads its updated time.
    const db = memDb(time)
    const topic = seedTopic(db)
    const id = seedAction(db, {
      lane: 'slow',
      kind: 'topics.reject',
      args: JSON.stringify({ ids: [topic] }),
    })
    time.setNow(new Date('2026-08-01T10:00:05Z'))
    const tick = actionsUnit(db, 'slow', {
      time,
      channelsDir: '/nonexistent',
      runsRoot: '/nonexistent',
      run: async () => {
        await time.advanceBy(595_000)
        return {}
      },
    })
    await tick()
    const row = getAction(db, id)
    expect(row?.startedAt).toBe('2026-08-01T10:00:05.000Z')
    expect(row?.finishedAt).toBe('2026-08-01T10:10:00.000Z')
    expect(row?.startedAt).not.toBe(row?.finishedAt)
  })

  it('still executes at most one action per poll on the slow lane, given two runnable rows', async () => {
    // The scan-window widening (fix for head-of-line starvation) must not
    // also widen the completion budget: slow stays one-per-poll.
    const db = memDb(time)
    const a = seedTopic(db, { title: 'slow-a' })
    const b = seedTopic(db, { title: 'slow-b' })
    const first = seedAction(db, {
      lane: 'slow',
      kind: 'topics.reject',
      args: JSON.stringify({ ids: [a] }),
    })
    const second = seedAction(db, {
      lane: 'slow',
      kind: 'topics.reject',
      args: JSON.stringify({ ids: [b] }),
    })
    const result = await unit(db, 'slow')()
    expect(result.worked).toBe(true)
    const statuses = [first, second].map((id) => getAction(db, id)?.status)
    expect(statuses.filter((s) => s === 'done')).toHaveLength(1)
    expect(statuses.filter((s) => s === 'pending')).toHaveLength(1)
  })

  it('skips two consecutive lease-blocked rows to reach runnable work on the slow lane', async () => {
    // With a slow-lane budget of 1, fetching only budget + 1 = 2 rows meant
    // two lease-blocked rows in a row idled the lane forever, even with
    // runnable work at position 3. The scan window must be wide enough to
    // reach past them.
    const db = memDb(time)
    acquireLease(db, 'scout', 'someone-else', 60_000, time)
    const blockedA = seedAction(db, { lane: 'slow', kind: 'scout.run', args: '{}' })
    const blockedB = seedAction(db, { lane: 'slow', kind: 'scout.run', args: '{}' })
    const topic = seedTopic(db)
    const runnable = seedAction(db, {
      lane: 'slow',
      kind: 'topics.reject',
      args: JSON.stringify({ ids: [topic] }),
    })
    const result = await unit(db, 'slow')()
    expect(result.worked).toBe(true)
    expect(getAction(db, blockedA)?.status).toBe('pending')
    expect(getAction(db, blockedB)?.status).toBe('pending')
    expect(getAction(db, runnable)?.status).toBe('done')
  })

  it('fails a same-lane row with an unknown kind, naming the kind', async () => {
    const db = memDb(time)
    const id = seedAction(db, { lane: 'fast', kind: 'not-a-real-kind' })
    const result = await unit(db, 'fast')()
    expect(result.worked).toBe(true)
    const row = getAction(db, id)
    expect(row?.status).toBe('failed')
    expect(row?.error).toContain('not-a-real-kind')
  })

  it('fails a row whose args column is not valid JSON, rather than leaving it pending', async () => {
    const db = memDb(time)
    const id = seedAction(db, { kind: 'topics.reject', args: '{not valid json' })
    const result = await unit(db)()
    expect(result.worked).toBe(true)
    const row = getAction(db, id)
    expect(row?.status).toBe('failed')
    expect(row?.error).toContain('not valid JSON')
  })

  it('drains at most MAX_FAST_DRAIN actions in one poll, leaving the rest pending', async () => {
    const ids: number[] = []
    const db = memDb(time)
    for (let i = 0; i < MAX_FAST_DRAIN + 1; i++) {
      const topic = seedTopic(db, { title: `bulk-${i}` })
      ids.push(seedAction(db, { kind: 'topics.reject', args: JSON.stringify({ ids: [topic] }) }))
    }
    const result = await unit(db)()
    expect(result.worked).toBe(true)
    const statuses = ids.map((id) => getAction(db, id)?.status)
    expect(statuses.filter((s) => s === 'done')).toHaveLength(MAX_FAST_DRAIN)
    expect(statuses.filter((s) => s === 'pending')).toHaveLength(1)
  })

  // The next four tests use `kind: 'scout.run'`, which really is a slow-lane,
  // scout-leased action — but the `run` option is stubbed in every one of
  // them, so scoutAll never actually runs. `lane` is a plain column the
  // worker filters rows on, independent of the catalog's own `lane` for
  // `kind`, which the fourth test below relies on to put this same kind on
  // the FAST lane instead.

  it('acquires a slow action lease with the slow TTL, not the lease default', async () => {
    time.setNow(new Date('2026-08-01T00:00:00.000Z'))
    const db = memDb(time)
    seedAction(db, { kind: 'scout.run', lane: 'slow', args: '{}' })
    let expiryDuringRun = ''
    const unit = actionsUnit(db, 'slow', {
      time,
      channelsDir: 'c',
      runsRoot: 'r',
      run: () => {
        expiryDuringRun = leaseExpiry(db, 'scout')
        return Promise.resolve({ ok: true })
      },
    })
    await unit()
    expect(expiryDuringRun).toBe(
      new Date(time.now().getTime() + SLOW_ACTION_LEASE_TTL_MS).toISOString(),
    )
  })

  it('refreshes a slow action lease while the handler is still running', async () => {
    time.setNow(new Date('2026-08-01T00:00:00.000Z'))
    const db = memDb(time)
    seedAction(db, { kind: 'scout.run', lane: 'slow', args: '{}' })
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const unit = actionsUnit(db, 'slow', {
      time,
      channelsDir: 'c',
      runsRoot: 'r',
      run: async () => {
        await gate
        return { ok: true }
      },
    })
    const running = unit()
    await time.advanceBy(0)
    const before = leaseExpiry(db, 'scout')
    await time.advanceBy(SLOW_ACTION_HEARTBEAT_MS)
    const after = leaseExpiry(db, 'scout')
    expect(after > before).toBe(true)
    release()
    await running
  })

  it('stops refreshing once the handler settles, win or lose', async () => {
    time.setNow(new Date('2026-08-01T00:00:00.000Z'))
    const db = memDb(time)
    seedAction(db, { kind: 'scout.run', lane: 'slow', args: '{}' })
    const unit = actionsUnit(db, 'slow', {
      time,
      channelsDir: 'c',
      runsRoot: 'r',
      run: () => Promise.reject(new Error('boom')),
    })
    await unit()
    // The lease row is gone (released in the finally), so a surviving interval
    // would be extending nothing — assert the timer itself is cleared.
    expect(time.pendingTimerCount()).toBe(0)
  })

  // scout.run is really slow-lane, catalog-wise, but this row's `lane`
  // column is forced to 'fast' to exercise the generic mechanism: any lease
  // acquired through this path now always uses SLOW_ACTION_LEASE_TTL_MS
  // regardless of its lane. Every managed lease requires periodic renewal.
  it('renews every managed lease, even on an artificially fast-lane action', async () => {
    time.setNow(new Date('2026-08-01T00:00:00.000Z'))
    const db = memDb(time)
    seedAction(db, { kind: 'scout.run', lane: 'fast', args: '{}' })
    let expiryDuringRun = ''
    let timersDuringRun = -1
    const unit = actionsUnit(db, 'fast', {
      time,
      channelsDir: 'c',
      runsRoot: 'r',
      run: () => {
        expiryDuringRun = leaseExpiry(db, 'scout')
        timersDuringRun = time.pendingTimerCount()
        return Promise.resolve({ ok: true })
      },
    })
    await unit()
    expect(expiryDuringRun).toBe(
      new Date(time.now().getTime() + SLOW_ACTION_LEASE_TTL_MS).toISOString(),
    )
    expect(timersDuringRun).toBe(1)
    expect(time.pendingTimerCount()).toBe(0)
  })
})
