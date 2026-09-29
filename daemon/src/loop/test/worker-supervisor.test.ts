import { beforeEach, describe, expect, it, vi } from 'vitest'
import { runWorkers } from '../worker-supervisor.js'
import { createTestTime, type TestTime } from '../../../testing/time.js'

let time: TestTime
beforeEach(() => {
  time = createTestTime(0)
})

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe('runWorkers', () => {
  it('does not invoke a unit when already aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    let calls = 0
    await runWorkers(
      [
        {
          name: 'one',
          unit: async () => {
            calls++
            return { worked: false }
          },
        },
      ],
      {
        signal: controller.signal,
        time,
        emit: () => {},
      },
    )
    expect(calls).toBe(0)
  })

  it('aborts idle siblings but waits for active work before rejecting', async () => {
    const controller = new AbortController()
    const gate = deferred()
    const sleeping = deferred<AbortSignal>()
    const failed = deferred()
    let activeFinished = false
    let settled = false
    const sleep = time.sleep
    vi.spyOn(time, 'sleep').mockImplementation((ms, signal) => {
      sleeping.resolve(signal!)
      return sleep(ms, signal)
    })
    const running = runWorkers(
      [
        {
          name: 'failing',
          unit: async () => {
            await failed.promise
            return { worked: true, line: {} }
          },
        },
        {
          name: 'active',
          unit: async () => {
            await gate.promise
            activeFinished = true
            return { worked: true }
          },
        },
        { name: 'idle', unit: async () => ({ worked: false }) },
      ],
      {
        signal: controller.signal,
        time,
        emit: () => {
          throw new Error('output failed')
        },
      },
    )
    const rejection = expect(running).rejects.toThrow('output failed')
    void running.then(
      () => {
        settled = true
      },
      () => {
        settled = true
      },
    )
    const internal = await sleeping.promise
    const aborted = new Promise<void>((resolve) =>
      internal.addEventListener('abort', () => resolve(), { once: true }),
    )
    failed.resolve()
    await aborted
    expect(settled).toBe(false)
    expect(activeFinished).toBe(false)
    gate.resolve()
    await rejection
    expect(activeFinished).toBe(true)
    expect(controller.signal.aborted).toBe(false)
  })

  it('forwards cancellation into sleep and removes the forwarding listener', async () => {
    const external = new AbortController()
    const remove = vi.spyOn(external.signal, 'removeEventListener')
    const entered = deferred()
    const sleep = time.sleep
    vi.spyOn(time, 'sleep').mockImplementation((ms, signal) => {
      entered.resolve()
      return sleep(ms, signal)
    })
    const running = runWorkers([{ name: 'idle', unit: async () => ({ worked: false }) }], {
      signal: external.signal,
      time,
      emit: () => {},
    })
    await entered.promise
    external.abort()
    await running
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function))
  })

  it('selects failures in specification order and cleans listeners on failure', async () => {
    vi.spyOn(time, 'sleep').mockImplementation(async (ms) => {
      throw new Error(`sleep ${ms}`)
    })
    const external = new AbortController()
    const remove = vi.spyOn(external.signal, 'removeEventListener')
    await expect(
      runWorkers(
        [
          { name: 'first', idleSleepMs: 1, unit: async () => ({ worked: false }) },
          { name: 'second', idleSleepMs: 2, unit: async () => ({ worked: false }) },
        ],
        {
          signal: external.signal,
          time,
          emit: () => {},
        },
      ),
    ).rejects.toThrow('sleep 1')
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function))
  })
})
