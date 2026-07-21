import type { Database } from 'better-sqlite3'
import type { ChannelConfig } from '../config/channel.js'
import {
  channelDaySpentMicros,
  globalDailyCapMicros,
  globalDaySpentMicros,
} from '../jobs/costs.js'
import type { Tier } from '../jobs/types.js'

// Resuming under this headroom would only re-park the job 'blocked' at the
// next budget checkpoint — the tick is better spent on new work (spec §6).
export const RESUME_MIN_HEADROOM_USD_MICROS = 2_000_000

export type TickPlan =
  | { kind: 'resume'; jobId: string; channel: string; tier: Tier }
  | { kind: 'produce'; channel: string; topicId: number; topic: string; tier: Tier }
  | { kind: 'noop'; reason: 'no-eligible-work' }

// Pure decision function: SELECTs only. produce-next executes the plan and
// owns every write, so a crashed tick never leaves half a decision behind.
export function planTick(
  db: Database,
  channels: ChannelConfig[],
  opts: { falKeyPresent: boolean },
): TickPlan {
  const byName = new Map(channels.map((c) => [c.name, c]))

  // RESUME PASS: blocked jobs were healthy when parked — recovering their
  // sunk cost beats spending on new work. Oldest first; an ineligible job is
  // skipped, not terminal (a later one may belong to a channel with headroom).
  const blocked = db
    .prepare(
      "SELECT id, channel, tier FROM jobs WHERE status = 'blocked' ORDER BY created_at ASC, id ASC",
    )
    .all() as { id: string; channel: string; tier: Tier }[]
  const globalRemainingMicros = globalDailyCapMicros() - globalDaySpentMicros(db)
  for (const job of blocked) {
    const channel = byName.get(job.channel)
    if (channel === undefined) continue // channel TOML no longer in the dir
    // Resuming premium without the key would only convert a healthy parked
    // job into a failed one.
    if (job.tier === 'premium' && !opts.falKeyPresent) continue
    const channelRemainingMicros =
      channel.budget.perDayUsdMicros - channelDaySpentMicros(db, job.channel)
    if (channelRemainingMicros < RESUME_MIN_HEADROOM_USD_MICROS) continue
    if (globalRemainingMicros < RESUME_MIN_HEADROOM_USD_MICROS) continue
    return { kind: 'resume', jobId: job.id, channel: job.channel, tier: job.tier }
  }

  return { kind: 'noop', reason: 'no-eligible-work' }
}
