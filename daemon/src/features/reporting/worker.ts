import type { Database } from 'better-sqlite3'
import type { UnitResult, WorkerUnit } from '../../shared/contracts/worker.js'
import { localDay, systemTime, type TimeSource } from '../../shared/time.js'
import { digestForChannelsDir } from './digest.js'

export const DIGEST_HOUR = 8

/** Fires once per local day at or after DIGEST_HOUR. In-memory guard: a
 * restart later the same day re-fires once — acceptable for a read-only
 * report whose only delivery is the log stream. */
export function digestUnit(
  db: Database,
  opts: { channelsDir: string; time?: TimeSource },
): WorkerUnit {
  let lastDay: string | undefined
  const time = opts.time ?? systemTime
  // Synchronous inner: the digest is a pure SQLite read with nothing to await,
  // so the promise exists only because every unit shares one signature.
  const tick = (): UnitResult => {
    const now = time.now()
    if (now.getHours() < DIGEST_HOUR || lastDay === localDay(now)) return { worked: false }
    const text = digestForChannelsDir(db, opts.channelsDir, { time })
    lastDay = localDay(now)
    return { worked: true, line: { action: 'digest', text } }
  }
  return () => Promise.resolve(tick())
}
