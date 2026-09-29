import type { Database } from 'better-sqlite3'
import type { LeaseContext } from './lease.js'
import { produceNextTick } from './produce-next.js'
import type { WorkerUnit } from './worker-contract.js'

export function produceUnit(
  db: Database,
  opts: {
    channelsDir: string
    runsRoot: string
    tick?: typeof produceNextTick
    daemonLease?: LeaseContext
  },
): WorkerUnit {
  const tick = opts.tick ?? produceNextTick
  return async () => {
    const result = await tick(db, {
      channelsDir: opts.channelsDir,
      runsRoot: opts.runsRoot,
      daemonLease: opts.daemonLease,
    })
    return { worked: result.action !== 'noop', line: { ...result } }
  }
}
