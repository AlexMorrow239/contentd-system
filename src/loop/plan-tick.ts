import type { Database } from 'better-sqlite3'
import type { ChannelConfig } from '../config/channel.js'
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
  return { kind: 'noop', reason: 'no-eligible-work' }
}
