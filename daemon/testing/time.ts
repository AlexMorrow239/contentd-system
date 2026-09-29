import { createClock } from '@sinonjs/fake-timers'
import { sleepWithTime, type TimeSource } from '../src/time.js'

export interface TestTime extends TimeSource {
  advanceBy(ms: number): Promise<void>
  setNow(value: Date | number): void
  pendingTimerCount(): number
}

/** Isolated scheduler: never installs or replaces process-global APIs. */
export function createTestTime(start: Date | number): TestTime {
  const clock = createClock(start instanceof Date ? start.getTime() : start)
  const time: TestTime = {
    now: () => new Date(clock.now),
    sleep: (ms, signal) => sleepWithTime(time, ms, signal),
    setTimeout(callback, ms) {
      const timer = clock.setTimeout(callback, ms)
      return () => clock.clearTimeout(timer)
    },
    startInterval(callback, ms) {
      const timer = clock.setInterval(callback, ms)
      return () => clock.clearInterval(timer)
    },
    async advanceBy(ms) {
      if (!Number.isFinite(ms) || ms < 0)
        throw new Error('advanceBy requires a nonnegative duration')
      await clock.tickAsync(ms)
    },
    setNow: (value) => clock.setSystemTime(value),
    pendingTimerCount: () => clock.countTimers(),
  }
  return time
}
