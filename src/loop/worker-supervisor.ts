import { runWorker } from './worker-loop.js'
import { abortableSleep } from './timers.js'
import type { WorkerDeps, WorkerSpec } from './worker-contract.js'

/** Stop siblings on failure and join every active unit before returning. */
export async function runWorkers(
  workers: readonly WorkerSpec[],
  opts: {
    signal: AbortSignal
    emit: WorkerDeps['emit']
    sleep?: (ms: number, signal: AbortSignal) => Promise<void>
  },
): Promise<void> {
  const controller = new AbortController()
  const abort = (): void => controller.abort()
  if (opts.signal.aborted) abort()
  else opts.signal.addEventListener('abort', abort, { once: true })
  try {
    const deps: WorkerDeps = {
      emit: opts.emit,
      sleep: (ms) => (opts.sleep ?? abortableSleep)(ms, controller.signal),
    }
    const settled = await Promise.allSettled(
      workers.map(({ name, unit, idleSleepMs }) =>
        runWorker(name, unit, controller.signal, deps, { idleSleepMs }).catch((err: unknown) => {
          controller.abort()
          throw err
        }),
      ),
    )
    const failed = settled.find((outcome) => outcome.status === 'rejected')
    if (failed?.status === 'rejected') throw failed.reason
  } finally {
    opts.signal.removeEventListener('abort', abort)
  }
}
