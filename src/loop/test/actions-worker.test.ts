import { describe, expect, it, vi } from 'vitest'
import type { Database } from 'better-sqlite3'
import { runAction } from '../../actions/handlers.js'
import { getAction } from '../../actions/queue.js'
import { memDb, seedAction, seedTopic } from '../../testing/db.js'
import { acquireLease } from '../lease.js'
import { readDaemonState } from '../daemon-state.js'
import type { UnitResult } from '../daemon.js'
import {
  actionsUnit,
  FAST_ACTION_LEASE_TTL_MS,
  MAX_FAST_DRAIN,
  SLOW_ACTION_HEARTBEAT_MS,
  SLOW_ACTION_LEASE_TTL_MS,
} from '../actions-worker.js'
import { SCOUT_LEASE_TTL_MS } from '../../scout/scout.js'

function unit(db: Database, lane: 'fast' | 'slow' = 'fast'): () => Promise<UnitResult> {
  return actionsUnit(db, lane, {
    channelsDir: '/nonexistent/channels',
    runsRoot: '/nonexistent/runs',
    now: () => new Date('2026-08-01T10:00:00Z'),
  })
}

function leaseExpiry(db: Database, name: string): string {
  const row = db.prepare('SELECT expires_at FROM leases WHERE name = ?').get(name) as
    | { expires_at: string }
    | undefined
  return row?.expires_at ?? ''
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
    const db = memDb()
    acquireLease(db, 'scout', 'someone-else', 60_000)
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
    const db = memDb()
    acquireLease(db, 'scout', 'someone-else', 60_000)
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
    const db = memDb()
    seedAction(db, { kind: 'scout.run', lane: 'fast', args: '{}' })
    seedAction(db, { kind: 'scout.run', lane: 'fast', args: '{}' })
    seedAction(db, { kind: 'scout.run', lane: 'fast', args: '{}' })
    // Someone else holds it for the whole poll.
    expect(acquireLease(db, 'scout', 'pid:other', 60_000)).toBe(true)

    const result = await unit(db)()

    expect(result).toEqual({
      worked: false,
      line: { action: 'noop', reason: 'lease-held', lease: 'scout' },
    })
    const notices = db
      .prepare('SELECT notice FROM operator_actions ORDER BY id ASC')
      .all() as { notice: string | null }[]
    // Only the FIRST blocked row is touched: the rest are skipped before any
    // acquire attempt, so they never get a notice written.
    expect(notices.map((r) => r.notice)).toEqual([
      'waiting for the scout lease',
      null,
      null,
    ])
    // All three are still pending — skipping is not failing.
    const statuses = db
      .prepare('SELECT status FROM operator_actions ORDER BY id ASC')
      .all() as { status: string }[]
    expect(statuses.map((r) => r.status)).toEqual(['pending', 'pending', 'pending'])
  })

  it('releases the lease it took', async () => {
    const db = memDb()
    // channelsDir is '/nonexistent/channels' (see `unit`), so scout.run's
    // handler folds the load failure into a benign noop rather than throwing
    // — this test only cares that the lease is freed either way.
    seedAction(db, { kind: 'scout.run', args: '{}' })
    await unit(db)()
    // A lease left held would wedge the scout worker for its whole TTL.
    expect(acquireLease(db, 'scout', 'next-caller', 1_000)).toBe(true)
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

  it('threads the clock per row so a slow action records real elapsed time, not poll skew', async () => {
    // A single frozen Date per poll would stamp started_at === finished_at
    // for an action that genuinely takes minutes. Inject a clock with
    // increasing values and assert the two columns land on DIFFERENT reads.
    const db = memDb()
    const topic = seedTopic(db)
    const id = seedAction(db, {
      lane: 'slow',
      kind: 'topics.reject',
      args: JSON.stringify({ ids: [topic] }),
    })
    const times = [
      '2026-08-01T10:00:00.000Z', // poll-level now (sweep + heartbeat gate)
      '2026-08-01T10:00:05.000Z', // started_at
      '2026-08-01T10:10:00.000Z', // finished_at, ten minutes later
    ]
    let i = 0
    const clock = vi.fn<() => Date>(() => new Date(times[Math.min(i++, times.length - 1)]))
    const tick = actionsUnit(db, 'slow', {
      channelsDir: '/nonexistent',
      runsRoot: '/nonexistent',
      now: clock,
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
    const db = memDb()
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
    const db = memDb()
    acquireLease(db, 'scout', 'someone-else', 60_000)
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

  it('acquires a fast-lane action lease with the short TTL, not the long per-lease TTL', async () => {
    const db = memDb()
    seedAction(db, { kind: 'scout.run', args: '{}' })
    let expiresAt: string | undefined
    const before = Date.now()
    const tick = actionsUnit(db, 'fast', {
      channelsDir: '/nonexistent',
      runsRoot: '/nonexistent',
      now: () => new Date('2026-08-01T10:00:00Z'),
      run: async (ctx, kind, args) => {
        // Inspect the lease row while the action is in flight and still
        // holds it.
        const row = db.prepare('SELECT expires_at FROM leases WHERE name = ?').get('scout') as
          | { expires_at: string }
          | undefined
        expiresAt = row?.expires_at
        return runAction(ctx, kind, args)
      },
    })
    await tick()
    expect(expiresAt).toBeDefined()
    const ttl = new Date(expiresAt as string).getTime() - before
    expect(ttl).toBeGreaterThan(0)
    // Generous tolerance around FAST_ACTION_LEASE_TTL_MS (60s), but nowhere
    // near the 30-minute SCOUT_LEASE_TTL_MS a lane-unaware TTL would use.
    expect(ttl).toBeLessThan(FAST_ACTION_LEASE_TTL_MS + 10_000)
    expect(ttl).toBeLessThan(SCOUT_LEASE_TTL_MS)
  })

  it('fails a same-lane row with an unknown kind, naming the kind', async () => {
    const db = memDb()
    const id = seedAction(db, { lane: 'fast', kind: 'not-a-real-kind' })
    const result = await unit(db, 'fast')()
    expect(result.worked).toBe(true)
    const row = getAction(db, id)
    expect(row?.status).toBe('failed')
    expect(row?.error).toContain('not-a-real-kind')
  })

  it('fails a row whose args column is not valid JSON, rather than leaving it pending', async () => {
    const db = memDb()
    const id = seedAction(db, { kind: 'topics.reject', args: '{not valid json' })
    const result = await unit(db)()
    expect(result.worked).toBe(true)
    const row = getAction(db, id)
    expect(row?.status).toBe('failed')
    expect(row?.error).toContain('not valid JSON')
  })

  it('drains at most MAX_FAST_DRAIN actions in one poll, leaving the rest pending', async () => {
    const ids: number[] = []
    const db = memDb()
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
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-01T00:00:00.000Z'))
    try {
      const db = memDb()
      seedAction(db, { kind: 'scout.run', lane: 'slow', args: '{}' })
      let expiryDuringRun = ''
      const unit = actionsUnit(db, 'slow', {
        channelsDir: 'c',
        runsRoot: 'r',
        run: () => {
          expiryDuringRun = leaseExpiry(db, 'scout')
          return Promise.resolve({ ok: true })
        },
      })
      await unit()
      expect(expiryDuringRun).toBe(
        new Date(Date.now() + SLOW_ACTION_LEASE_TTL_MS).toISOString(),
      )
    } finally {
      vi.useRealTimers()
    }
  })

  it('refreshes a slow action lease while the handler is still running', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-01T00:00:00.000Z'))
    try {
      const db = memDb()
      seedAction(db, { kind: 'scout.run', lane: 'slow', args: '{}' })
      let release!: () => void
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      const unit = actionsUnit(db, 'slow', {
        channelsDir: 'c',
        runsRoot: 'r',
        run: async () => {
          await gate
          return { ok: true }
        },
      })
      const running = unit()
      await vi.advanceTimersByTimeAsync(0)
      const before = leaseExpiry(db, 'scout')
      await vi.advanceTimersByTimeAsync(SLOW_ACTION_HEARTBEAT_MS)
      const after = leaseExpiry(db, 'scout')
      expect(after > before).toBe(true)
      release()
      await running
    } finally {
      vi.useRealTimers()
    }
  })

  it('stops refreshing once the handler settles, win or lose', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-01T00:00:00.000Z'))
    try {
      const db = memDb()
      seedAction(db, { kind: 'scout.run', lane: 'slow', args: '{}' })
      const unit = actionsUnit(db, 'slow', {
        channelsDir: 'c',
        runsRoot: 'r',
        run: () => Promise.reject(new Error('boom')),
      })
      await unit()
      // The lease row is gone (released in the finally), so a surviving interval
      // would be extending nothing — assert the timer itself is cleared.
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('leaves the fast lane on the fast TTL with no heartbeat', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-01T00:00:00.000Z'))
    try {
      const db = memDb()
      seedAction(db, { kind: 'scout.run', lane: 'fast', args: '{}' })
      let expiryDuringRun = ''
      let timersDuringRun = -1
      const unit = actionsUnit(db, 'fast', {
        channelsDir: 'c',
        runsRoot: 'r',
        run: () => {
          expiryDuringRun = leaseExpiry(db, 'scout')
          timersDuringRun = vi.getTimerCount()
          return Promise.resolve({ ok: true })
        },
      })
      await unit()
      expect(expiryDuringRun).toBe(
        new Date(Date.now() + FAST_ACTION_LEASE_TTL_MS).toISOString(),
      )
      expect(timersDuringRun).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })
})
