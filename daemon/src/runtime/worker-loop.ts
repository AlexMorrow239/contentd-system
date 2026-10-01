import type { UnitResult, WorkerDeps, WorkerUnit } from '../shared/contracts/worker.js'
import { errorMessage } from '../shared/errors.js'

export const IDLE_SLEEP_MS = 30_000
export const ERROR_SLEEP_MS = 60_000

/**
 * The daemon's one loop shape: check demand -> one unit -> re-check
 * immediately; idle sleeps IDLE_SLEEP_MS; a throwing unit logs and sleeps
 * ERROR_SLEEP_MS — the daemon never dies over one bad tick. Consecutive
 * identical idle lines are deduped so a quiet night is silent, not 2,880
 * noop lines; any worked unit (or error) resets the dedupe so the next idle
 * reason is reported once.
 */
export async function runWorker(
  name: string,
  unit: WorkerUnit,
  signal: AbortSignal,
  deps: WorkerDeps,
  // The actions-fast worker polls at ~1s so a row mutation feels immediate;
  // every other worker keeps the 30s default.
  opts: { idleSleepMs?: number } = {},
): Promise<void> {
  const idleSleepMs = opts.idleSleepMs ?? IDLE_SLEEP_MS
  let lastIdleKey: string | undefined
  while (!signal.aborted) {
    let result: UnitResult
    try {
      result = await unit()
    } catch (err) {
      lastIdleKey = undefined
      // Deliberately NOT deduped, unlike idle lines: a unit failing the same
      // way for the tenth minute running is the signal, not noise.
      deps.emit({ worker: name, action: 'worker-error', error: errorMessage(err) })
      await deps.time.sleep(ERROR_SLEEP_MS, signal)
      continue
    }
    if (result.worked) {
      lastIdleKey = undefined
      if (result.line !== undefined) deps.emit({ worker: name, ...result.line })
      continue
    }
    if (result.line !== undefined) {
      const key = JSON.stringify(result.line)
      if (key !== lastIdleKey) {
        lastIdleKey = key
        deps.emit({ worker: name, ...result.line })
      }
    }
    await deps.time.sleep(idleSleepMs, signal)
  }
}
