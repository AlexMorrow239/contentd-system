import type { Database } from 'better-sqlite3'
import { reconcileActions } from '../features/actions/recovery.js'
import { actionsUnit } from '../features/actions/worker.js'
import { cleanupUnit } from '../features/library/cleanup.js'
import { produceUnit } from '../features/production/worker.js'
import { digestUnit } from '../features/reporting/worker.js'
import { scoutUnit } from '../features/scouting/worker.js'
import type { LeaseContext } from '../infra/coordination/lease.js'
import type { WorkerSpec } from '../shared/contracts/worker.js'
import { resolveTime, type TimeSource } from '../shared/time.js'

export const FAST_IDLE_SLEEP_MS = 1_000

/** Startup recovery is work too: callers may exercise it without a loop. */
export function initializeDaemonWork(db: Database, lease: LeaseContext): void {
  reconcileActions(db, lease)
}

/** Construct each stateful unit once; the runtime repeatedly invokes it. */
export function createDaemonWorkers(
  db: Database,
  opts: { channelsDir: string; runsRoot: string; time?: TimeSource; daemonLease?: LeaseContext },
): WorkerSpec[] {
  opts = { ...opts, time: resolveTime(opts.time, opts.daemonLease) }
  return [
    { name: 'produce', unit: produceUnit(db, opts) },
    { name: 'scout', unit: scoutUnit(db, opts) },
    { name: 'digest', unit: digestUnit(db, opts) },
    { name: 'actions-fast', unit: actionsUnit(db, 'fast', opts), idleSleepMs: FAST_IDLE_SLEEP_MS },
    { name: 'actions-slow', unit: actionsUnit(db, 'slow', opts) },
    { name: 'cleanup', unit: cleanupUnit(db, opts) },
  ]
}
