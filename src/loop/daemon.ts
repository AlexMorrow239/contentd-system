import { errorMessage } from '../errors.js'

export const IDLE_SLEEP_MS = 30_000
export const ERROR_SLEEP_MS = 60_000

/** One worker iteration's outcome. `worked` = re-check demand immediately;
 * idle = sleep first. `line` is the JSON log line; an idle result may omit it
 * to stay silent without resetting the dedupe (see runWorker). */
export interface UnitResult {
  worked: boolean
  line?: Record<string, unknown>
}

export interface WorkerDeps {
  sleep: (ms: number) => Promise<void>
  emit: (line: Record<string, unknown>) => void
}

/** setTimeout that resolves early (never rejects) when the signal aborts, so
 * SIGTERM ends an idle sleep in milliseconds, not thirty seconds. */
export function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve()
      return
    }
    const timer = setTimeout(done, ms)
    function done(): void {
      signal.removeEventListener('abort', done)
      clearTimeout(timer)
      resolve()
    }
    signal.addEventListener('abort', done)
  })
}

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
  unit: () => Promise<UnitResult>,
  signal: AbortSignal,
  deps: WorkerDeps,
): Promise<void> {
  let lastIdleKey: string | undefined
  while (!signal.aborted) {
    let result: UnitResult
    try {
      result = await unit()
    } catch (err) {
      lastIdleKey = undefined
      deps.emit({ worker: name, action: 'worker-error', error: errorMessage(err) })
      await deps.sleep(ERROR_SLEEP_MS)
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
    await deps.sleep(IDLE_SLEEP_MS)
  }
}
