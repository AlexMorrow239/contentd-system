import type { Database } from 'better-sqlite3'
import { createDaemonWorkers, initializeDaemonWork } from './daemon-workers.js'
import { requireLease } from './lease.js'
import { runWorkers } from './worker-supervisor.js'
import type { WorkerDeps, WorkerSpec } from './worker-contract.js'
import { systemTime, type TimeSource } from '../time.js'

/** Process lifecycle and production wiring. Work and polling live elsewhere. */
export async function runDaemon(
  db: Database,
  opts: {
    channelsDir: string
    runsRoot: string
    time?: TimeSource
    emit?: WorkerDeps['emit']
    signal?: AbortSignal
    workers?: readonly WorkerSpec[]
  },
): Promise<void> {
  const time = opts.time ?? systemTime
  const daemonLease = requireLease(db, 'daemon', undefined, { time })
  const controller = new AbortController()
  const abort = (): void => controller.abort()
  try {
    daemonLease.signal.addEventListener('abort', abort, { once: true })
    if (opts.signal === undefined) {
      process.once('SIGTERM', abort)
      process.once('SIGINT', abort)
    } else if (opts.signal.aborted) {
      abort()
    } else {
      opts.signal.addEventListener('abort', abort, { once: true })
    }
    // Injected workers bypass production startup work as well as construction.
    if (opts.workers === undefined) initializeDaemonWork(db, daemonLease)
    const workers = opts.workers ?? createDaemonWorkers(db, { ...opts, time, daemonLease })
    const emit =
      opts.emit ??
      ((line: Record<string, unknown>) => process.stdout.write(JSON.stringify(line) + '\n'))
    emit({ action: 'daemon-started', pid: process.pid })
    await runWorkers(
      workers.map((worker) => ({
        ...worker,
        unit: () => {
          daemonLease.assertOwned()
          return worker.unit()
        },
      })),
      { signal: controller.signal, emit, time },
    )
    if (daemonLease.signal.aborted) throw daemonLease.signal.reason
  } finally {
    process.removeListener('SIGTERM', abort)
    process.removeListener('SIGINT', abort)
    opts.signal?.removeEventListener('abort', abort)
    daemonLease.signal.removeEventListener('abort', abort)
    daemonLease.release()
  }
}
