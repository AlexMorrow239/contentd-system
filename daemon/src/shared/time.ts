// 'YYYY-MM-DD' in the MACHINE's local time zone — never toISOString() (that
// renders UTC). Callers that key a day off this (digest windows, quota
// tracking, the daemon's once-a-day digest gate) deliberately use the
// operator's calendar day, not UTC's.
export function localDay(now: Date): string {
  const year = now.getFullYear()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}
export type CancelTimer = () => void

export interface TimeSource {
  now(): Date
  sleep(ms: number, signal?: AbortSignal): Promise<void>
  setTimeout(callback: () => void, ms: number, opts?: { unref?: boolean }): CancelTimer
  startInterval(callback: () => void, ms: number): CancelTimer
}

/** Shared cancellation semantics for both real and isolated test clocks. */
export function sleepWithTime(time: TimeSource, ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve()
      return
    }
    const cancel = time.setTimeout(done, ms)
    function done(): void {
      signal?.removeEventListener('abort', done)
      cancel()
      resolve()
    }
    signal?.addEventListener('abort', done, { once: true })
  })
}

export const systemTime: TimeSource = {
  now: () => new Date(),
  sleep: (ms, signal) => sleepWithTime(systemTime, ms, signal),
  setTimeout(callback, ms, opts) {
    const timer = setTimeout(callback, ms)
    if (opts?.unref) timer.unref()
    return () => clearTimeout(timer)
  },
  startInterval(callback, ms) {
    const timer = setInterval(callback, ms)
    timer.unref()
    return () => clearInterval(timer)
  },
}

/** Choose one clock before acquiring ownership or making domain writes. */
export function resolveTime(
  time?: TimeSource,
  ...owners: ({ time: TimeSource } | undefined)[]
): TimeSource {
  const resolved = time ?? owners.find((owner) => owner !== undefined)?.time ?? systemTime
  if (owners.some((owner) => owner !== undefined && owner.time !== resolved))
    throw new Error('conflicting time sources')
  return resolved
}

/** A request owns this deadline until its response body has been consumed. */
export function createDeadline(
  time: TimeSource,
  ms: number,
  parent?: AbortSignal,
): {
  signal: AbortSignal
  dispose: () => void
} {
  const controller = new AbortController()
  let cancel: CancelTimer = () => {}
  const dispose = (): void => {
    cancel()
    parent?.removeEventListener('abort', parentLost)
  }
  const parentLost = (): void => {
    controller.abort(parent?.reason)
    dispose()
  }
  if (parent?.aborted) parentLost()
  else {
    cancel = time.setTimeout(
      () => {
        controller.abort(new DOMException('The operation timed out', 'TimeoutError'))
        dispose()
      },
      ms,
      { unref: true },
    )
    parent?.addEventListener('abort', parentLost, { once: true })
  }
  return { signal: controller.signal, dispose }
}
