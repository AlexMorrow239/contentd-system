import { describe, expect, it, vi } from 'vitest'
import {
  DIGEST_HOUR,
  ERROR_SLEEP_MS,
  IDLE_SLEEP_MS,
  abortableSleep,
  digestUnit,
  produceUnit,
  runDaemon,
  runWorker,
  scoutUnit,
} from '../daemon.js'
import type { UnitResult, WorkerDeps } from '../daemon.js'
import { acquireLease, releaseLease } from '../lease.js'
import { readDaemonState } from '../daemon-state.js'
import { ScoutRunFailedError } from '../../scout/scout.js'
import type { ScoutChannelResult } from '../../scout/scout.js'
import { enqueueAction, getAction } from '../../actions/queue.js'
import { memDb, seedAction, seedTopic } from '../../testing/db.js'
import { channelToml, writeChannelsDir } from '../../testing/channel.js'
import { tmpDir } from '../../testing/tmp.js'

// Harness: runs `unit` under runWorker, aborting after `iterations` calls.
async function drive(
  results: (UnitResult | Error)[],
): Promise<{ lines: Record<string, unknown>[]; sleeps: number[] }> {
  const lines: Record<string, unknown>[] = []
  const sleeps: number[] = []
  const controller = new AbortController()
  let i = 0
  const unit = async (): Promise<UnitResult> => {
    const next = results[i++]
    if (i >= results.length) controller.abort()
    if (next instanceof Error) throw next
    return next
  }
  const deps: WorkerDeps = {
    emit: (line) => lines.push(line),
    sleep: async (ms) => {
      sleeps.push(ms)
    },
  }
  await runWorker('w', unit, controller.signal, deps)
  return { lines, sleeps }
}

/** A mutable clock the time-gated units take as `now`, so no test ever waits. */
function fakeClock(start: Date): { now: () => Date; advance: (ms: number) => void } {
  let ms = start.getTime()
  return {
    now: () => new Date(ms),
    advance: (delta: number) => {
      ms += delta
    },
  }
}

function scoutResult(channel: string, over: Partial<ScoutChannelResult> = {}): ScoutChannelResult {
  return {
    channel,
    fetched: 0,
    droppedMedia: 0,
    droppedAutomated: 0,
    droppedBodyless: 0,
    alreadyKnown: 0,
    scored: 0,
    queued: 0,
    rejected: 0,
    sourceErrors: [],
    costUsdMicros: 0,
    ...over,
  }
}

/**
 * One channel on disk plus a counting stub in place of scoutAll — the channel
 * declares no `[scout]` table since the stub decides what scouting "returns",
 * so the real source list never matters.
 */
function scoutFixture(scout: () => Promise<ScoutChannelResult[]>): {
  db: ReturnType<typeof memDb>
  channelsDir: string
  calls: () => number
  scout: () => Promise<ScoutChannelResult[]>
} {
  let calls = 0
  return {
    db: memDb(),
    channelsDir: writeChannelsDir({ 'a.toml': channelToml({ name: 'a' }) }),
    calls: () => calls,
    scout: async () => {
      calls++
      return scout()
    },
  }
}

// Midday, so the scout recheck arithmetic never straddles a day boundary.
const SCOUT_NOW = new Date(2026, 6, 28, 12, 0, 0)

// Before DIGEST_HOUR, so the digest worker in the runDaemon tests stays idle
// instead of building a report they don't care about.
const BEFORE_DIGEST = new Date(2026, 6, 28, DIGEST_HOUR - 1, 0, 0)

describe('runWorker', () => {
  it('re-checks immediately after a worked unit — no sleep', async () => {
    const { sleeps } = await drive([{ worked: true }, { worked: true }])
    expect(sleeps).toEqual([])
  })

  it('sleeps IDLE_SLEEP_MS after each idle unit', async () => {
    // the harness aborts only after the LAST unit call returns, so both idle
    // iterations reach their sleep — two entries, not one
    const { sleeps } = await drive([{ worked: false }, { worked: false }])
    expect(sleeps).toEqual([IDLE_SLEEP_MS, IDLE_SLEEP_MS])
  })

  it('emits a worked line every time', async () => {
    const { lines } = await drive([
      { worked: true, line: { action: 'produced' } },
      { worked: true, line: { action: 'produced' } },
    ])
    expect(lines).toHaveLength(2)
    expect(lines[0]).toMatchObject({ worker: 'w', action: 'produced' })
  })

  it('dedupes identical consecutive idle lines', async () => {
    const idle = { worked: false, line: { action: 'noop', reason: 'no-eligible-work' } }
    const { lines } = await drive([idle, idle, idle])
    expect(lines).toHaveLength(1)
  })

  it('re-emits when the idle reason changes', async () => {
    const { lines } = await drive([
      { worked: false, line: { action: 'noop', reason: 'no-eligible-work' } },
      { worked: false, line: { action: 'noop', reason: 'backlog-full' } },
    ])
    expect(lines).toHaveLength(2)
  })

  it('a line-less idle iteration neither emits nor resets the dedupe', async () => {
    const idle = { worked: false, line: { action: 'noop', reason: 'queue-full' } }
    const { lines } = await drive([idle, { worked: false }, idle])
    expect(lines).toHaveLength(1)
  })

  it('a worked unit resets the idle dedupe', async () => {
    const idle = { worked: false, line: { action: 'noop', reason: 'paced' } }
    const { lines } = await drive([idle, { worked: true, line: { action: 'published' } }, idle])
    expect(lines).toHaveLength(3)
  })

  it('logs a classified error and sleeps ERROR_SLEEP_MS instead of dying', async () => {
    const { lines, sleeps } = await drive([new Error('boom'), { worked: false }])
    expect(lines[0]).toMatchObject({ worker: 'w', action: 'worker-error' })
    expect(String(lines[0].error)).toContain('boom')
    expect(sleeps[0]).toBe(ERROR_SLEEP_MS)
  })

  it('stops without another unit call once aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    let calls = 0
    await runWorker(
      'w',
      async () => {
        calls++
        return { worked: false }
      },
      controller.signal,
      { emit: () => {}, sleep: async () => {} },
    )
    expect(calls).toBe(0)
  })
})

describe('abortableSleep', () => {
  it('resolves immediately when the signal is already aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    // A 10-minute timer that never fires: the await returning is the assertion.
    await abortableSleep(600_000, controller.signal)
  })

  it('resolves promptly when the signal aborts mid-sleep, and drops its listener', async () => {
    const controller = new AbortController()
    const removeListener = vi.spyOn(controller.signal, 'removeEventListener')
    const sleeping = abortableSleep(600_000, controller.signal)
    controller.abort()
    await sleeping
    expect(removeListener).toHaveBeenCalledWith('abort', expect.any(Function))
  })

  it('resolves on a zero-length sleep', async () => {
    await abortableSleep(0, new AbortController().signal)
  })
})

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

describe('scoutUnit', () => {
  // The recheck cadence and the queue-depth gate both live inside
  // scoutChannel/scoutAll now (backed by the persisted scout_state table),
  // so scoutUnit itself carries no scheduling state — it calls `scout` on
  // every loaded channel on every invocation and just maps the outcome.
  // Recheck/queue-depth behavior itself is covered in scout.test.ts.

  it('scouts on every call — no per-channel scheduling of its own', async () => {
    const fx = scoutFixture(async () => [scoutResult('a', { queued: 1 })])
    const unit = scoutUnit(fx.db, {
      channelsDir: fx.channelsDir,
      now: () => SCOUT_NOW,
      scout: fx.scout,
    })

    expect((await unit()).worked).toBe(true)
    expect((await unit()).worked).toBe(true)
    expect(fx.calls()).toBe(2)
  })

  it('is idle without a line when every channel is skipped as not-yet-due', async () => {
    const fx = scoutFixture(async () => [scoutResult('a', { skipped: 'recheck-not-due' })])
    const unit = scoutUnit(fx.db, {
      channelsDir: fx.channelsDir,
      now: () => SCOUT_NOW,
      scout: fx.scout,
    })

    expect(await unit()).toEqual({ worked: false })
  })

  it('reports queue-full when every skipped result includes at least one queue-full', async () => {
    const fx = scoutFixture(async () => [
      scoutResult('a', { skipped: 'queue-full' }),
      scoutResult('b', { skipped: 'recheck-not-due' }),
    ])
    const unit = scoutUnit(fx.db, {
      channelsDir: fx.channelsDir,
      now: () => SCOUT_NOW,
      scout: fx.scout,
    })

    expect(await unit()).toEqual({ worked: false, line: { action: 'noop', reason: 'queue-full' } })
  })

  it('names an empty scout pass no-scout-sources, not queue-full', async () => {
    // Real scoutAll here, not the stub: the fixture channel declares no
    // `[scout]` table, so scoutAll skips it without touching a source and
    // returns []. `[].every(...)` is vacuously true, which used to report
    // this as `queue-full` — a queue depth nothing ever measured.
    const db = memDb()
    const channelsDir = writeChannelsDir({ 'a.toml': channelToml({ name: 'a' }) })
    const unit = scoutUnit(db, { channelsDir, now: () => SCOUT_NOW })

    expect(await unit()).toEqual({
      worked: false,
      line: { action: 'noop', reason: 'no-scout-sources' },
    })
  })

  it('reports lease-held as idle without calling scout', async () => {
    const fx = scoutFixture(async () => [scoutResult('a', { queued: 1 })])
    const unit = scoutUnit(fx.db, {
      channelsDir: fx.channelsDir,
      now: () => SCOUT_NOW,
      scout: fx.scout,
    })
    expect(acquireLease(fx.db, 'scout', 'someone-else', 600_000)).toBe(true)

    expect(await unit()).toEqual({ worked: false, line: { action: 'noop', reason: 'lease-held' } })
    expect(fx.calls()).toBe(0)

    releaseLease(fx.db, 'scout', 'someone-else')
    expect((await unit()).worked).toBe(true)
    expect(fx.calls()).toBe(1)
  })

  it('a ScoutRunFailedError still counts as worked', async () => {
    const fx = scoutFixture(async () => {
      throw new ScoutRunFailedError('every source failed', [])
    })
    const unit = scoutUnit(fx.db, {
      channelsDir: fx.channelsDir,
      now: () => SCOUT_NOW,
      scout: fx.scout,
    })

    const result = await unit()
    expect(result.worked).toBe(true)
    expect(result.line).toMatchObject({ action: 'scouted', channels: [] })
    expect(String(result.line?.error)).toContain('every source failed')
  })

  it('reports a broken channels dir as a config-error noop', async () => {
    const db = memDb()
    const channelsDir = writeChannelsDir({ 'a.toml': 'not = [valid' })
    const unit = scoutUnit(db, {
      channelsDir,
      now: () => SCOUT_NOW,
      scout: async () => {
        throw new Error('must not be called')
      },
    })
    const result = await unit()
    expect(result.worked).toBe(false)
    expect(result.line).toMatchObject({ action: 'noop', reason: 'config-error' })
  })

  it('releases the scout lease after a run', async () => {
    const fx = scoutFixture(async () => [scoutResult('a', { queued: 1 })])
    const unit = scoutUnit(fx.db, {
      channelsDir: fx.channelsDir,
      now: () => SCOUT_NOW,
      scout: fx.scout,
    })
    await unit()
    expect(acquireLease(fx.db, 'scout', 'someone-else', 1000)).toBe(true)
  })
})

describe('digestUnit', () => {
  it('does nothing before DIGEST_HOUR', async () => {
    const db = memDb()
    const channelsDir = writeChannelsDir({ 'a.toml': channelToml({ name: 'a' }) })
    const clock = fakeClock(new Date(2026, 6, 28, DIGEST_HOUR - 1, 59))
    const unit = digestUnit(db, { channelsDir, now: clock.now })
    expect(await unit()).toEqual({ worked: false })
  })

  it('fires once after DIGEST_HOUR and not again the same day', async () => {
    const db = memDb()
    const channelsDir = writeChannelsDir({ 'a.toml': channelToml({ name: 'a' }) })
    const clock = fakeClock(new Date(2026, 6, 28, DIGEST_HOUR, 1))
    const unit = digestUnit(db, { channelsDir, now: clock.now })

    const first = await unit()
    expect(first.worked).toBe(true)
    expect(first.line?.action).toBe('digest')
    expect(typeof first.line?.text).toBe('string')

    clock.advance(3_600_000)
    expect(await unit()).toEqual({ worked: false })
  })

  it('fires again on the next local day', async () => {
    const db = memDb()
    const channelsDir = writeChannelsDir({ 'a.toml': channelToml({ name: 'a' }) })
    const clock = fakeClock(new Date(2026, 6, 28, DIGEST_HOUR, 1))
    const unit = digestUnit(db, { channelsDir, now: clock.now })

    expect((await unit()).worked).toBe(true)
    clock.advance(86_400_000)
    expect((await unit()).worked).toBe(true)
  })
})

describe('runDaemon', () => {
  it('emits a start line and stops all workers on abort', async () => {
    const db = memDb()
    const channelsDir = writeChannelsDir({})
    const lines: Record<string, unknown>[] = []
    const controller = new AbortController()
    // Pre-aborted: every worker exits before its first unit call, so the tick
    // implementations never run and no process signal handlers are installed.
    controller.abort()

    await runDaemon(db, {
      channelsDir,
      runsRoot: '/nowhere',
      signal: controller.signal,
      emit: (line) => lines.push(line),
      sleep: async () => {},
    })

    expect(lines[0]).toEqual({ action: 'daemon-started', pid: process.pid })
  })

  it('stops every other worker before rejecting when one throws outside its unit', async () => {
    const db = memDb()
    const channelsDir = writeChannelsDir({})
    // An external signal that never fires: only the daemon's own internal
    // controller can stop the survivors. Without it they keep looping while
    // cli.ts's `finally` closes the db handle out from under them.
    const external = new AbortController()
    let sleeps = 0

    const running = runDaemon(db, {
      channelsDir,
      runsRoot: '/nowhere',
      now: () => BEFORE_DIGEST,
      signal: external.signal,
      // emit is called OUTSIDE runWorker's try/catch — an EPIPE on stdout is
      // the real shape of this, and no unit-level handler can catch it.
      emit: (line) => {
        if (line.worker === 'produce') throw new Error('emit exploded')
      },
      sleep: async () => {
        sleeps++
      },
    })

    await expect(running).rejects.toThrow('emit exploded')
    // Everything is settled by the time the rejection surfaces: no worker
    // takes another sleep after this point.
    const atRejection = sleeps
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(sleeps).toBe(atRejection)
  })

  it('chains an external signal that aborts mid-run', async () => {
    const db = memDb()
    const channelsDir = writeChannelsDir({})
    const external = new AbortController()
    let sleeps = 0

    const running = runDaemon(db, {
      channelsDir,
      runsRoot: '/nowhere',
      now: () => BEFORE_DIGEST,
      signal: external.signal,
      emit: () => {},
      sleep: async () => {
        sleeps++
      },
    })
    external.abort()
    await running

    const atReturn = sleeps
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(sleeps).toBe(atReturn)
  })

  it('polls the fast action lane, which stamps the daemon heartbeat', async () => {
    // Asserted through a SIDE EFFECT, not an emitted line: an idle actions
    // worker deliberately emits NOTHING (Task 6's byte-stable idle result), so
    // there is no log line to look for. The heartbeat stamp is actions-fast's
    // observable proof of life.
    const db = memDb()
    const controller = new AbortController()
    await runDaemon(db, {
      channelsDir: tmpDir('brainrot-daemon-'),
      runsRoot: tmpDir('brainrot-runs-'),
      emit: () => {},
      sleep: () => {
        controller.abort()
        return Promise.resolve()
      },
      signal: controller.signal,
    })
    expect(readDaemonState(db)?.pid).toBe(process.pid)
  })

  it('polls the slow action lane, whose startup sweep is lane-scoped', async () => {
    // Also a side effect, and deliberately one that needs NO slow-lane action
    // kind to exist: failRunningActions is a lane-scoped SQL update that never
    // looks at `kind`, so a stale slow-lane row being swept proves actions-slow
    // was constructed and polled. Every ACTIONS entry is fast-lane in phase 1.
    const db = memDb()
    const stale = seedAction(db, { lane: 'slow', kind: 'produce', status: 'running' })
    const controller = new AbortController()
    await runDaemon(db, {
      channelsDir: tmpDir('brainrot-daemon-'),
      runsRoot: tmpDir('brainrot-runs-'),
      emit: () => {},
      sleep: () => {
        controller.abort()
        return Promise.resolve()
      },
      signal: controller.signal,
    })
    expect(getAction(db, stale)?.status).toBe('failed')
    expect(getAction(db, stale)?.error).toContain('daemon restart')
  })

  it('executes a queued action end to end through the daemon', async () => {
    const db = memDb()
    const topic = seedTopic(db)
    const id = enqueueAction(db, {
      kind: 'topics.reject',
      args: { ids: [topic] },
      requestedBy: 'dashboard',
    })
    const controller = new AbortController()
    await runDaemon(db, {
      channelsDir: tmpDir('brainrot-daemon-'),
      runsRoot: tmpDir('brainrot-runs-'),
      emit: () => {},
      sleep: () => {
        controller.abort()
        return Promise.resolve()
      },
      signal: controller.signal,
    })
    expect(getAction(db, id)?.status).toBe('done')
  })
})
