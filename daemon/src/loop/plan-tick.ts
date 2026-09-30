import type { Database } from 'better-sqlite3'
import type { ChannelConfig } from '../config/channel.js'
import { budgetWaitEligible } from '../jobs/budget-wait.js'
import { pendingInventory } from '../jobs/library.js'
import { eligibleTopic } from '../scout/topics.js'
import { systemTime, type TimeSource } from '../time.js'

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
export function planTick(
  db: Database,
  channels: ChannelConfig[],
  time: TimeSource = systemTime,
): TickPlan {
  const byName = new Map(channels.map((c) => [c.name, c]))

  const now = time.now()
  let anyBacklogged = false
  const hasCapacity = (channel: ChannelConfig): boolean => {
    const backlogged =
      pendingInventory(db, {
        channel: channel.name,
        declared: channel.platforms,
      }) >= backlogCap(channel)
    if (backlogged) anyBacklogged = true
    return !backlogged
  }

  // Recover interrupted attempts first, then budget waits. Every resume obeys
  // the inventory ceiling; retry deadlines stop rapid re-entry after refusal.
  const resumable = db
    .prepare(
      `SELECT id, channel, status, budget_wait_json FROM jobs
       WHERE deleted_at IS NULL AND ((status = 'queued' AND recovery_pending = 1) OR status = 'blocked')
         AND (retry_after IS NULL OR retry_after <= ?)
       ORDER BY CASE WHEN status = 'queued' THEN 0 ELSE 1 END, created_at ASC, id ASC`,
    )
    .all(now.toISOString()) as {
    id: string
    channel: string
    status: string
    budget_wait_json: string | null
  }[]
  for (const job of resumable) {
    const channel = byName.get(job.channel)
    if (channel === undefined || !hasCapacity(channel)) continue
    if (job.status === 'blocked' && !budgetWaitEligible(db, channel, job.budget_wait_json, now))
      continue
    return { kind: 'resume', jobId: job.id, channel: job.channel }
  }

  // CLAIM PASS: a slot is consumed at job creation regardless of outcome — a
  // deterministic failure must not burn the whole day's budget on retries.
  const quotaStmt = db.prepare(
    'SELECT COUNT(*) AS n FROM jobs WHERE channel = ? ' + 'AND substr(created_at, 1, 10) = ?',
  )
  const jobsToday = (name: string): number =>
    (quotaStmt.get(name, now.toISOString().slice(0, 10)) as { n: number }).n
  // Depth gate, ahead of the daily rate gate: producing into a full backlog
  // consumes local capacity faster than videos are handled. A channel
  // with no declared platforms is gated the same way — nothing drains it, so
  // it fills once and then waits for the operator to post videos or delete their jobs
  // by hand.
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
