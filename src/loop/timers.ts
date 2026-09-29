import type { StartInterval } from './worker-contract.js'

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

/** Schedule without holding the process open. Cancelling twice is harmless. */
export const startInterval: StartInterval = (callback, ms) => {
  const timer = setInterval(callback, ms)
  timer.unref()
  return () => clearInterval(timer)
}
