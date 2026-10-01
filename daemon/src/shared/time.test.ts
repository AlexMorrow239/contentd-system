import { describe, expect, it } from 'vitest'
import { createTestTime } from '../../testing/time.js'
import { createDeadline } from './time.js'

describe('TimeSource', () => {
  it('advances sleeps and intervals together without changing another clock', async () => {
    const time = createTestTime(0)
    const other = createTestTime(100)
    const events: number[] = []
    const cancel = time.startInterval(() => events.push(time.now().getTime()), 10)
    const sleep = time.sleep(25).then(() => events.push(time.now().getTime()))
    await time.advanceBy(25)
    await sleep
    expect(events).toEqual([10, 20, 25])
    expect(other.now().getTime()).toBe(100)
    time.now().setTime(900)
    expect(time.now().getTime()).toBe(25)
    cancel()
    cancel()
    expect(time.pendingTimerCount()).toBe(0)
  })

  it('cancels an aborted sleep and does not fire timers on a wall-clock jump', async () => {
    const time = createTestTime(0)
    const controller = new AbortController()
    const sleeping = time.sleep(100, controller.signal)
    time.setNow(1000)
    expect(time.pendingTimerCount()).toBe(1)
    controller.abort()
    await sleeping
    await time.sleep(100, controller.signal)
    expect(time.pendingTimerCount()).toBe(0)
  })

  it('expires deadlines and preserves parent cancellation with no leftover timers', async () => {
    const time = createTestTime(0)
    const deadline = createDeadline(time, 100)
    await time.advanceBy(99)
    expect(deadline.signal.aborted).toBe(false)
    await time.advanceBy(1)
    expect(deadline.signal.reason).toBeInstanceOf(DOMException)
    expect((deadline.signal.reason as DOMException).name).toBe('TimeoutError')
    deadline.dispose()
    const parent = new AbortController()
    const child = createDeadline(time, 100, parent.signal)
    const reason = new Error('ownership lost')
    parent.abort(reason)
    expect(child.signal.reason).toBe(reason)
    expect(time.pendingTimerCount()).toBe(0)
    child.dispose()
  })
})
