import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { tmpDir } from './testing/tmp.js'
import { createTestTime } from './testing/time.js'
import { readCaffeinateEnabled, watchDaemon } from './caffeinate.js'

function fixture() {
  const time = createTestTime(0)
  const controller = new AbortController()
  let running = false
  let enabled = true
  let held = false
  const start = vi.fn(() => {
    held = true
    return {
      isRunning: () => held,
      stop: () => {
        held = false
      },
    }
  })
  const isRunning = vi.fn(async () => running)
  const log = vi.fn()
  return {
    time,
    controller,
    start,
    isRunning,
    log,
    get held() {
      return held
    },
    setRunning(value: boolean) {
      running = value
    },
    setEnabled(value: boolean) {
      enabled = value
    },
    loseAssertion() {
      held = false
    },
    run: () =>
      watchDaemon({
        time,
        signal: controller.signal,
        isRunning,
        start,
        enabled: () => enabled,
        log,
      }),
  }
}

describe('watchDaemon', () => {
  it('holds one assertion only while the daemon runs, including after a restart', async () => {
    const f = fixture()
    const task = f.run()
    try {
      await f.time.advanceBy(0)
      expect(f.held).toBe(false)
      f.setRunning(true)
      await f.time.advanceBy(30_000)
      expect(f.held).toBe(true)
      await f.time.advanceBy(30_000)
      expect(f.start).toHaveBeenCalledTimes(1)
      f.setRunning(false)
      await f.time.advanceBy(30_000)
      expect(f.held).toBe(false)
      f.setRunning(true)
      await f.time.advanceBy(30_000)
      expect(f.held).toBe(true)
    } finally {
      f.controller.abort()
      await task
    }
    expect(f.held).toBe(false)
    expect(f.time.pendingTimerCount()).toBe(0)
  })

  it('releases and reacquires the assertion when configuration changes', async () => {
    const f = fixture()
    f.setRunning(true)
    const task = f.run()
    try {
      await f.time.advanceBy(0)
      expect(f.held).toBe(true)
      f.setEnabled(false)
      await f.time.advanceBy(30_000)
      expect(f.held).toBe(false)
      f.setEnabled(true)
      await f.time.advanceBy(30_000)
      expect(f.held).toBe(true)
    } finally {
      f.controller.abort()
      await task
    }
  })

  it('releases on Docker failure and recovers when Docker returns', async () => {
    const f = fixture()
    f.setRunning(true)
    const task = f.run()
    try {
      await f.time.advanceBy(0)
      f.isRunning.mockRejectedValueOnce(new Error('Docker unavailable'))
      await f.time.advanceBy(30_000)
      expect(f.held).toBe(false)
      expect(f.log).toHaveBeenCalledWith(expect.stringContaining('Docker unavailable'))
      await f.time.advanceBy(30_000)
      expect(f.held).toBe(true)
      f.loseAssertion()
      await f.time.advanceBy(30_000)
      expect(f.held).toBe(true)
      expect(f.start).toHaveBeenCalledTimes(3)
    } finally {
      f.controller.abort()
      await task
    }
  })

  it('does not acquire an assertion if shutdown happens during a Docker check', async () => {
    const f = fixture()
    let complete!: (value: boolean) => void
    f.isRunning.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          complete = resolve
        }),
    )
    const task = f.run()
    f.controller.abort()
    complete(true)
    await task
    expect(f.held).toBe(false)
    expect(f.start).not.toHaveBeenCalled()
    expect(f.time.pendingTimerCount()).toBe(0)
  })

  it('releases an assertion created while shutdown is already in progress', async () => {
    const time = createTestTime(0)
    const controller = new AbortController()
    let held = false
    const task = watchDaemon({
      time,
      signal: controller.signal,
      enabled: () => true,
      isRunning: async () => true,
      start: () => {
        held = true
        controller.abort()
        return {
          isRunning: () => held,
          stop: () => {
            held = false
          },
        }
      },
      log: () => {},
    })
    await task
    expect(held).toBe(false)
    expect(time.pendingTimerCount()).toBe(0)
  })

  it('recovers from an assertion startup error without stopping the monitor', async () => {
    const f = fixture()
    f.setRunning(true)
    f.start.mockImplementationOnce(() => {
      throw new Error('spawn failed')
    })
    const task = f.run()
    try {
      await f.time.advanceBy(0)
      expect(f.held).toBe(false)
      expect(f.log).toHaveBeenCalledWith('spawn failed')
      await f.time.advanceBy(30_000)
      expect(f.held).toBe(true)
    } finally {
      f.controller.abort()
      await task
    }
  })
})

describe('readCaffeinateEnabled', () => {
  it('defaults on and reloads the file without modifying process environment', () => {
    const root = tmpDir()
    expect(readCaffeinateEnabled(root, {})).toBe(true)
    writeFileSync(join(root, '.env'), 'BRAINROT_CAFFEINATE=false\n')
    expect(readCaffeinateEnabled(root, {})).toBe(false)
    writeFileSync(join(root, '.env'), 'BRAINROT_CAFFEINATE=true\n')
    expect(readCaffeinateEnabled(root, {})).toBe(true)
  })

  it('honors explicit environment overrides and rejects invalid values', () => {
    const root = tmpDir()
    writeFileSync(join(root, '.env'), 'BRAINROT_CAFFEINATE=true\n')
    expect(readCaffeinateEnabled(root, { BRAINROT_CAFFEINATE: 'false' })).toBe(false)
    expect(() => readCaffeinateEnabled(root, { BRAINROT_CAFFEINATE: 'typo' })).toThrow(
      'BRAINROT_CAFFEINATE',
    )
  })
})
