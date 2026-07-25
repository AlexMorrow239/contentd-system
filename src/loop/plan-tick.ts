import type { Database } from 'better-sqlite3'
import type { ChannelConfig } from '../config/channel.js'
import {
  channelDaySpentMicros,
  globalDailyCapMicros,
  globalDaySpentMicros,
  jobSpentMicros,
} from '../jobs/costs.js'
import type { Tier } from '../jobs/types.js'
import { eligibleTopic } from '../scout/topics.js'

// Resuming under this headroom would only re-park the job 'blocked' at the
// next budget checkpoint — the tick is better spent on new work (spec §6).
export const RESUME_MIN_HEADROOM_USD_MICROS = 2_000_000

// The same minimum step against a cap that may be smaller than $2 (a per-video
// cap always is; a modest channel's daily cap can be). A flat floor would lock
// such a cap's jobs out of resume permanently, even at zero spend — so take a
// quarter of the cap whenever that is the smaller number. The global cap is
// operator-scale, so it keeps the absolute floor.
function resumeFloorMicros(capMicros: number): number {
  return Math.min(RESUME_MIN_HEADROOM_USD_MICROS, Math.floor(capMicros / 4))
}

export type TickPlan =
  | { kind: 'resume'; jobId: string; channel: string; tier: Tier }
  | { kind: 'produce'; channel: string; topicId: number; topic: string; tier: Tier }
  | { kind: 'noop'; reason: 'no-eligible-work' | 'no-fal-key' }

// Pure decision function: SELECTs only. produce-next executes the plan and
// owns every write, so a crashed tick never leaves half a decision behind.
export function planTick(
  db: Database,
  channels: ChannelConfig[],
  opts: { falKeyPresent: boolean },
): TickPlan {
  const byName = new Map(channels.map((c) => [c.name, c]))
  let skippedForKey = false

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
    if (job.tier === 'premium' && !opts.falKeyPresent) {
      skippedForKey = true
      continue
    }
    // Per-video first, and unlike the day caps it never resets: a job parked
    // at its own cap can ONLY re-block, and — same created_at, oldest first —
    // it would head the queue every tick forever, starving every channel.
    const perVideoCapMicros =
      job.tier === 'premium'
        ? channel.budget.premiumPerVideoUsdMicros
        : channel.budget.perVideoUsdMicros
    const perVideoRemainingMicros = perVideoCapMicros - jobSpentMicros(db, job.id)
    if (perVideoRemainingMicros < resumeFloorMicros(perVideoCapMicros)) continue
    const channelRemainingMicros =
      channel.budget.perDayUsdMicros - channelDaySpentMicros(db, job.channel)
    if (channelRemainingMicros < resumeFloorMicros(channel.budget.perDayUsdMicros)) continue
    if (globalRemainingMicros < RESUME_MIN_HEADROOM_USD_MICROS) continue
    return { kind: 'resume', jobId: job.id, channel: job.channel, tier: job.tier }
  }

  // CLAIM PASS: a tier slot is consumed at job creation regardless of
  // outcome — a deterministic failure must not burn the whole day's budget
  // on retries.
  const quotaStmt = db.prepare(
    'SELECT COUNT(*) AS n FROM jobs WHERE channel = ? AND tier = ? ' +
      "AND substr(created_at, 1, 10) = strftime('%Y-%m-%d','now')",
  )
  const jobsToday = (name: string, tier: Tier): number =>
    (quotaStmt.get(name, tier) as { n: number }).n
  const candidates = channels
    .map((channel) => {
      const volumeToday = jobsToday(channel.name, 'volume')
      const premiumToday = jobsToday(channel.name, 'premium')
      return {
        channel,
        volumeOpen: volumeToday < channel.tierMix.volume,
        premiumOpen: premiumToday < channel.tierMix.premium,
        filledFraction:
          (volumeToday + premiumToday) / (channel.tierMix.volume + channel.tierMix.premium),
      }
    })
    // A zero tier mix closes both slots, so its NaN fraction never reaches
    // the sort.
    .filter((c) => c.volumeOpen || c.premiumOpen)
    .sort(
      (a, b) =>
        a.filledFraction - b.filledFraction || (a.channel.name < b.channel.name ? -1 : 1),
    )

  for (const { channel, volumeOpen, premiumOpen } of candidates) {
    const autoPremium = channel.scout.autoPremium
    // Premium first: scarce quality slots get the day's best material early.
    // Without the FAL key an eligible premium topic is skipped — volume still
    // flows — and the skip is remembered so an empty tick reports
    // 'no-fal-key' instead of masquerading as a starved queue.
    if (premiumOpen) {
      const topic = eligibleTopic(db, channel.name, 'premium', { autoPremium })
      if (topic !== null) {
        if (!opts.falKeyPresent) {
          skippedForKey = true
        } else {
          return {
            kind: 'produce',
            channel: channel.name,
            topicId: topic.id,
            topic: topic.title,
            tier: 'premium',
          }
        }
      }
    }
    if (volumeOpen) {
      const topic = eligibleTopic(db, channel.name, 'volume', { autoPremium })
      if (topic !== null) {
        return {
          kind: 'produce',
          channel: channel.name,
          topicId: topic.id,
          topic: topic.title,
          tier: 'volume',
        }
      }
    }
  }

  return { kind: 'noop', reason: skippedForKey ? 'no-fal-key' : 'no-eligible-work' }
}
