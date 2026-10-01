import type { Database } from 'better-sqlite3'
import type { LeaseContext } from '../../infra/coordination/lease.js'
import type { WorkerUnit } from '../../shared/contracts/worker.js'
import { resolveTime, type TimeSource } from '../../shared/time.js'
import { produceNextTick } from './produce-next.js'

export function produceUnit(
  db: Database,
  opts: {
    channelsDir: string
    runsRoot: string
    tick?: typeof produceNextTick
    daemonLease?: LeaseContext
    time?: TimeSource
  },
): WorkerUnit {
  const tick = opts.tick ?? produceNextTick
  const time = resolveTime(opts.time, opts.daemonLease)
  return async () => {
    const result = await tick(db, {
      channelsDir: opts.channelsDir,
      runsRoot: opts.runsRoot,
      daemonLease: opts.daemonLease,
      time,
    })
    return { worked: result.action !== 'noop', line: { ...result } }
  }
}
