import { describe, expect, it, vi } from 'vitest'
import { writeChannelsDir } from '../../../testing/channel.js'
import { memDb, seedAction, seedTopic } from '../../../testing/db.js'
import { createTestTime } from '../../../testing/time.js'
import { tmpDir } from '../../../testing/tmp.js'
import { enqueueAction, getAction } from '../../features/actions/queue.js'
import { readDaemonState } from '../../infra/coordination/daemon-state.js'
import { runDaemon } from '../daemon.js'

describe('runDaemon', () => {
  it('runs supplied workers exclusively and cleans up the external signal', async () => {
    const db = memDb()
    const id = seedAction(db, { status: 'running' })
    const external = new AbortController()
    const remove = vi.spyOn(external.signal, 'removeEventListener')
    const lines: Record<string, unknown>[] = []
    const term = process.listenerCount('SIGTERM')
    let calls = 0
    await runDaemon(db, {
      channelsDir: '/unused',
      runsRoot: '/unused',
      signal: external.signal,
      emit: (line) => lines.push(line),
      workers: [
        {
          name: 'injected',
          unit: async () => {
            calls++
            external.abort()
            return { worked: true, line: { action: 'custom' } }
          },
        },
      ],
    })
    expect(calls).toBe(1)
    expect(lines).toEqual([
      { action: 'daemon-started', pid: process.pid },
      { worker: 'injected', action: 'custom' },
    ])
    expect(getAction(db, id)?.status).toBe('running')
    expect(readDaemonState(db)).toBeNull()
    expect(db.prepare('SELECT * FROM leases').all()).toEqual([])
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function))
    expect(process.listenerCount('SIGTERM')).toBe(term)
  })

  it('removes process listeners after a successful run', async () => {
    const term = process.listenerCount('SIGTERM')
    const interrupt = process.listenerCount('SIGINT')
    const db = memDb()
    await runDaemon(db, {
      channelsDir: '/unused',
      runsRoot: '/unused',
      workers: [],
      emit: () => {},
    })
    expect(process.listenerCount('SIGTERM')).toBe(term)
    expect(process.listenerCount('SIGINT')).toBe(interrupt)
    expect(db.prepare('SELECT * FROM leases').all()).toEqual([])
  })

  it('removes process listeners and releases ownership when startup logging fails', async () => {
    const db = memDb()
    const term = process.listenerCount('SIGTERM')
    const interrupt = process.listenerCount('SIGINT')
    const beforeTerm = process.listeners('SIGTERM')
    const beforeInt = process.listeners('SIGINT')
    try {
      await expect(
        runDaemon(db, {
          channelsDir: '/unused',
          runsRoot: '/unused',
          emit: () => {
            throw new Error('startup failed')
          },
        }),
      ).rejects.toThrow('startup failed')
      expect(process.listenerCount('SIGTERM')).toBe(term)
      expect(process.listenerCount('SIGINT')).toBe(interrupt)
      expect(db.prepare('SELECT * FROM leases').all()).toEqual([])
    } finally {
      for (const listener of process.listeners('SIGTERM')) {
        if (!beforeTerm.includes(listener)) process.removeListener('SIGTERM', listener)
      }
      for (const listener of process.listeners('SIGINT')) {
        if (!beforeInt.includes(listener)) process.removeListener('SIGINT', listener)
      }
    }
  })

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
      time: createTestTime(0),
    })

    expect(lines[0]).toEqual({ action: 'daemon-started', pid: process.pid })
  })

  it('polls the fast action lane, which stamps the daemon heartbeat', async () => {
    // Asserted through a SIDE EFFECT, not an emitted line: an idle actions
    // worker deliberately emits NOTHING (Task 6's byte-stable idle result), so
    // there is no log line to look for. The heartbeat stamp is actions-fast's
    // observable proof of life.
    const db = memDb()
    const controller = new AbortController()
    const time = createTestTime(0)
    const running = runDaemon(db, {
      time,
      channelsDir: tmpDir('brainrot-daemon-'),
      runsRoot: tmpDir('brainrot-runs-'),
      emit: () => {},
      signal: controller.signal,
    })
    await time.advanceBy(0)
    controller.abort()
    await running
    expect(time.pendingTimerCount()).toBe(0)
    expect(readDaemonState(db)?.pid).toBe(process.pid)
  })

  it('reconciles interrupted actions on production startup', async () => {
    const db = memDb()
    const stale = seedAction(db, { lane: 'slow', kind: 'produce', status: 'running' })
    const controller = new AbortController()
    const time = createTestTime(0)
    const running = runDaemon(db, {
      time,
      channelsDir: tmpDir('brainrot-daemon-'),
      runsRoot: tmpDir('brainrot-runs-'),
      emit: () => {},
      signal: controller.signal,
    })
    await time.advanceBy(0)
    controller.abort()
    await running
    expect(time.pendingTimerCount()).toBe(0)
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
    const time = createTestTime(0)
    const running = runDaemon(db, {
      time,
      channelsDir: tmpDir('brainrot-daemon-'),
      runsRoot: tmpDir('brainrot-runs-'),
      emit: () => {},
      signal: controller.signal,
    })
    await time.advanceBy(0)
    controller.abort()
    await running
    expect(time.pendingTimerCount()).toBe(0)
    expect(getAction(db, id)?.status).toBe('done')
  })
})
