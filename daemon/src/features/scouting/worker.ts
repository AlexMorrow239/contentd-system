import type { Database } from 'better-sqlite3'
import { configErrorNoop, tryLoadChannelsDir } from '../../config/channel.js'
import { acquireManagedLease, type LeaseContext } from '../../infra/coordination/lease.js'
import type { WorkerUnit } from '../../shared/contracts/worker.js'
import { errorMessage } from '../../shared/errors.js'
import { resolveTime, type TimeSource } from '../../shared/time.js'
import { ScoutRunFailedError, scoutAll } from './run.js'
import type { ScoutChannelResult } from './types.js'

/**
 * One unit = one scoutAll pass over every configured channel. The recheck
 * cadence AND the queue-depth demand check both live INSIDE scoutChannel now
 * (skipped: 'recheck-not-due' / 'queue-full'), backed by the persisted
 * `scout_state` table — so this unit is a thin wrapper, like produceUnit,
 * with no scheduling state of its own. lease-held never reaches scoutChannel
 * at all, so it never records an attempt, for free.
 */
export function scoutUnit(
  db: Database,
  opts: {
    channelsDir: string
    time?: TimeSource
    scout?: typeof scoutAll
    daemonLease?: LeaseContext
  },
): WorkerUnit {
  const scout = opts.scout ?? scoutAll
  const time = resolveTime(opts.time, opts.daemonLease)
  return async () => {
    const loaded = tryLoadChannelsDir(opts.channelsDir)
    if (loaded.error !== undefined) return { worked: false, line: configErrorNoop(loaded.error) }
    if (loaded.channels.length === 0) return { worked: false }
    const lease = acquireManagedLease(db, 'scout', opts.daemonLease, { time })
    if (lease === null) {
      return { worked: false, line: { action: 'noop', reason: 'lease-held' } }
    }
    try {
      let results: ScoutChannelResult[]
      try {
        results = await scout(db, loaded.channels, { time, lease })
      } catch (err) {
        if (err instanceof ScoutRunFailedError) {
          return {
            worked: true,
            line: { action: 'scouted', channels: err.results, error: errorMessage(err) },
          }
        }
        throw err
      }
      // scoutAll drops channels with no [scout] sources before running any of
      // them, so `results` can be empty while `loaded.channels` is not.
      // `[].every(...)` is vacuously true, which reported "nothing is
      // scoutable" as `queue-full` — a queue depth nothing measured. Name the
      // two apart.
      if (results.length === 0) {
        return { worked: false, line: { action: 'noop', reason: 'no-scout-sources' } }
      }
      if (results.every((r) => r.skipped !== undefined)) {
        // Every channel was gated, either by queue depth or by not being due
        // for a recheck yet. The latter is the common every-30s case (most
        // channels sit inside SCOUT_RECHECK_MS most of the time) and stays
        // silent; queue-full is the rarer, more informative state worth
        // surfacing once via runWorker's idle dedupe.
        const anyQueueFull = results.some((r) => r.skipped === 'queue-full')
        return anyQueueFull
          ? { worked: false, line: { action: 'noop', reason: 'queue-full' } }
          : { worked: false }
      }
      return { worked: true, line: { action: 'scouted', channels: results } }
    } finally {
      lease.release()
    }
  }
}
