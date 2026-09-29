import type { Database } from 'better-sqlite3'
import { tryLoadChannelsDir } from '../config/channel.js'
import { localDay } from '../time.js'
import { buildDigest } from './digest.js'
import type { UnitResult, WorkerUnit } from './worker-contract.js'

export const DIGEST_HOUR = 8

/** Fires once per local day at or after DIGEST_HOUR. In-memory guard: a
 * restart later the same day re-fires once — acceptable for a read-only
 * report whose only delivery is the log stream. */
export function digestUnit(
  db: Database,
  opts: { channelsDir: string; now?: () => Date },
): WorkerUnit {
  let lastDay: string | undefined
  // Synchronous inner: buildDigest is a pure SQLite read with nothing to await,
  // so the promise exists only because every unit shares one signature.
  const tick = (): UnitResult => {
    const now = opts.now?.() ?? new Date()
    if (now.getHours() < DIGEST_HOUR || lastDay === localDay(now)) return { worked: false }
    const loaded = tryLoadChannelsDir(opts.channelsDir)
    const text = buildDigest(db, loaded.channels, { channelsError: loaded.error })
    lastDay = localDay(now)
    return { worked: true, line: { action: 'digest', text } }
  }
  return () => Promise.resolve(tick())
}
