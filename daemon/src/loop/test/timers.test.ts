import { describe, expect, it, vi } from 'vitest'
import { systemTime } from '../../time.js'
import { createTestTime } from '../../../testing/time.js'

describe('abortableSleep', () => {
  it('resolves immediately when the signal is already aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    // A 10-minute timer that never fires: the await returning is the assertion.
    await systemTime.sleep(600_000, controller.signal)
  })

  it('resolves promptly when the signal aborts mid-sleep, and drops its listener', async () => {
    const controller = new AbortController()
    const removeListener = vi.spyOn(controller.signal, 'removeEventListener')
    const sleeping = systemTime.sleep(600_000, controller.signal)
    controller.abort()
    await sleeping
    expect(removeListener).toHaveBeenCalledWith('abort', expect.any(Function))
  })

  it('resolves on a zero-length sleep', async () => {
    await systemTime.sleep(0, new AbortController().signal)
  })
})

describe('startInterval', () => {
  it('does not keep the process alive', () => {
    const interval = vi.spyOn(globalThis, 'setInterval')
    const cancel = systemTime.startInterval(() => {}, 60_000)
    try {
      const timer = interval.mock.results[0].value as ReturnType<typeof setInterval>
      expect(timer.hasRef()).toBe(false)
    } finally {
      cancel()
      interval.mockRestore()
    }
  })

  it('repeats until cancelled, with idempotent cleanup', async () => {
    const time = createTestTime(0)
    let calls = 0
    const cancel = time.startInterval(() => {
      calls++
    }, 10)
    await time.advanceBy(20)
    expect(calls).toBe(2)
    cancel()
    cancel()
    await time.advanceBy(20)
    expect(calls).toBe(2)
    expect(time.pendingTimerCount()).toBe(0)
  })
})
