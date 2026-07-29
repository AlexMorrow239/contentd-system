import { describe, expect, it } from 'vitest'
import { ERROR_SLEEP_MS, IDLE_SLEEP_MS, runWorker } from '../daemon.js'
import type { UnitResult, WorkerDeps } from '../daemon.js'

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
