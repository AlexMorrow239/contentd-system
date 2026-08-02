import type { Database } from 'better-sqlite3'
import type { ChannelConfig } from '../config/channel.js'
import {
  channelDaySpentMicros,
  globalDailyCapMicros,
  globalDaySpentMicros,
  jobSpentMicros,
} from '../jobs/costs.js'
import { pendingInventory } from '../jobs/library.js'
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
  | { kind: 'resume'; jobId: string; channel: string }
  | { kind: 'produce'; channel: string; topicId: number; topic: string }
  | { kind: 'noop'; reason: 'no-eligible-work' | 'backlog-full' }

// The inventory ceiling: how many finished, unposted videos a channel may
// hold before it stops producing. Derived from videos_per_day so that knob
// stays the single cadence dial — it now means "how many I intend to post per
// day".
//
// Exported for the digest, which reports channels sitting at this cap: a
// halted channel is otherwise invisible, and two definitions of the ceiling
// would let the report and the gate disagree about who is halted.
export function backlogCap(channel: ChannelConfig): number {
  return Math.ceil(channel.videosPerDay * channel.backlogDays)
}

// Pure decision function: SELECTs only. produce-next executes the plan and
// owns every write, so a crashed tick never leaves half a decision behind.
export function planTick(db: Database, channels: ChannelConfig[]): TickPlan {
  const byName = new Map(channels.map((c) => [c.name, c]))

  // RESUME PASS: blocked jobs were healthy when parked — recovering their
  // sunk cost beats spending on new work. Oldest first; an ineligible job is
  // skipped, not terminal (a later one may belong to a channel with headroom).
  const blocked = db
    .prepare(
      "SELECT id, channel FROM jobs WHERE status = 'blocked' ORDER BY created_at ASC, id ASC",
    )
    .all() as { id: string; channel: string }[]
  const globalRemainingMicros = globalDailyCapMicros() - globalDaySpentMicros(db)
  for (const job of blocked) {
    const channel = byName.get(job.channel)
    if (channel === undefined) continue // channel TOML no longer in the dir
    // Per-video first, and unlike the day caps it never resets: a job parked
    // at its own cap can ONLY re-block, and — same created_at, oldest first —
    // it would head the queue every tick forever, starving every channel.
    const perVideoCapMicros = channel.budget.perVideoUsdMicros
    const perVideoRemainingMicros = perVideoCapMicros - jobSpentMicros(db, job.id)
    if (perVideoRemainingMicros < resumeFloorMicros(perVideoCapMicros)) continue
    const channelRemainingMicros =
      channel.budget.perDayUsdMicros - channelDaySpentMicros(db, job.channel)
    if (channelRemainingMicros < resumeFloorMicros(channel.budget.perDayUsdMicros)) continue
    if (globalRemainingMicros < RESUME_MIN_HEADROOM_USD_MICROS) continue
    return { kind: 'resume', jobId: job.id, channel: job.channel }
  }

  // CLAIM PASS: a slot is consumed at job creation regardless of outcome — a
  // deterministic failure must not burn the whole day's budget on retries.
  const quotaStmt = db.prepare(
    'SELECT COUNT(*) AS n FROM jobs WHERE channel = ? ' +
      "AND substr(created_at, 1, 10) = strftime('%Y-%m-%d','now')",
  )
  const jobsToday = (name: string): number => (quotaStmt.get(name) as { n: number }).n
  // Depth gate, ahead of the daily rate gate: producing into a full backlog
  // is how object storage grows faster than videos are consumed. A channel
  // with no declared platforms is gated the same way — nothing drains it, so
  // it fills once and then waits for the operator to post or discard videos
  // by hand.
  let anyBacklogged = false
  const candidates = channels
    .map((channel) => {
      const today = jobsToday(channel.name)
      // Quota is cheaper to check and already excludes most channels most
      // ticks — skip the inventory query once quota alone closes it.
      const underQuota = today < channel.videosPerDay
      const backlogged =
        underQuota &&
        pendingInventory(db, {
          channel: channel.name,
          declared: channel.platforms,
        }) >= backlogCap(channel)
      if (backlogged) anyBacklogged = true
      return {
        channel,
        open: underQuota && !backlogged,
        filledFraction: today / channel.videosPerDay,
      }
    })
    .filter((c) => c.open)
    .sort(
      (a, b) => a.filledFraction - b.filledFraction || (a.channel.name < b.channel.name ? -1 : 1),
    )

  for (const { channel } of candidates) {
    const topic = eligibleTopic(db, channel.name)
    if (topic !== null) {
      return { kind: 'produce', channel: channel.name, topicId: topic.id, topic: topic.title }
    }
  }

  // 'backlog-full' only when a gated channel is the reason there is nothing to
  // do — a channel that was open but had no eligible topic is 'no-eligible-work'
  // regardless of what its neighbours were holding.
  return {
    kind: 'noop',
    reason: anyBacklogged && candidates.length === 0 ? 'backlog-full' : 'no-eligible-work',
  }
}
