import type { Database } from 'better-sqlite3'
import type { ChannelConfig } from '../../config/channel.js'
import type { Platform } from '../../shared/contracts/platforms.js'
import { systemTime, type TimeSource } from '../../shared/time.js'
import {
  channelDaySpentMicrosByChannel,
  globalDailyCapMicros,
  globalDaySpentMicros,
} from '../billing/costs.js'
import { pendingInventory } from '../library/library.js'
import { fullyPostedClause } from '../posting/posts.js'
import { candidateTopicCount, claimedTopicCount } from '../topics/queries.js'
import { FAILED_JOBS_LIMIT, STRANDED_QUEUED_MS, ZOMBIE_RUNNING_MS } from './policy.js'
function oldestUnpostedAge(
  db: Database,
  channel: string,
  declared: readonly Platform[],
  now: Date,
): number | null {
  const unposted = fullyPostedClause(declared, { alias: 'l', match: 'not-fully' })
  const row = db
    .prepare(
      `SELECT MIN(l.created_at) AS oldest FROM library l JOIN jobs j ON j.id = l.job_id
       WHERE j.channel = ? AND l.state IN ('needs-review', 'ready')
         AND ${unposted.sql}`,
    )
    .get(channel, ...unposted.params) as { oldest: string | null }
  return row.oldest === null ? null : now.getTime() - Date.parse(row.oldest)
}

export function collectDigest(
  db: Database,
  channels: ChannelConfig[],
  opts: { channelsError?: string; time?: TimeSource } = {},
) {
  const now = (opts.time ?? systemTime).now()
  const day = now.toISOString().slice(0, 10)
  const cutoff = new Date(now.getTime() - 86_400_000).toISOString()
  const topicRows = db
    .prepare(
      `SELECT channel, COUNT(*) AS scouted,
              SUM(CASE WHEN status = 'candidate' THEN 1 ELSE 0 END) AS candidate,
              SUM(CASE WHEN status = 'rejected' THEN 1 ELSE 0 END) AS rejected
       FROM topics WHERE datetime(created_at) >= datetime(?)
       GROUP BY channel ORDER BY channel`,
    )
    .all(cutoff) as {
    channel: string
    scouted: number
    candidate: number
    rejected: number
  }[]
  const jobRows = db
    .prepare(
      `SELECT j.channel, COUNT(*) AS total,
              SUM(CASE WHEN l.state = 'ready' THEN 1 ELSE 0 END) AS ready,
              SUM(CASE WHEN l.state = 'needs-review' THEN 1 ELSE 0 END) AS needsReview,
              SUM(CASE WHEN j.status = 'failed' THEN 1 ELSE 0 END) AS failed,
              SUM(CASE WHEN j.status = 'blocked' THEN 1 ELSE 0 END) AS blocked
       FROM jobs j LEFT JOIN library l ON l.job_id = j.id
       WHERE j.deleted_at IS NULL AND datetime(j.created_at) >= datetime(?)
       GROUP BY j.channel ORDER BY j.channel`,
    )
    .all(cutoff) as {
    channel: string
    total: number
    ready: number
    needsReview: number
    failed: number
    blocked: number
  }[]
  const spentByChannel = channelDaySpentMicrosByChannel(db, day)
  const failedJobCount = (
    db
      .prepare("SELECT COUNT(*) AS n FROM jobs WHERE deleted_at IS NULL AND status = 'failed'")
      .get() as { n: number }
  ).n
  const failedJobs = (
    db
      .prepare(
        "SELECT id, channel FROM jobs WHERE deleted_at IS NULL AND status = 'failed' ORDER BY created_at DESC, id DESC LIMIT ?",
      )
      .all(FAILED_JOBS_LIMIT) as { id: string; channel: string }[]
  ).reverse()
  const zombieCutoff = new Date(now.getTime() - ZOMBIE_RUNNING_MS).toISOString()
  const zombies = db
    .prepare(
      `SELECT j.id AS id, j.channel AS channel,
              COALESCE(MAX(s.started_at), j.created_at) AS lastStart
       FROM jobs j LEFT JOIN job_stages s ON s.job_id = j.id
       WHERE j.deleted_at IS NULL AND j.status = 'running'
       GROUP BY j.id, j.channel, j.created_at
       HAVING lastStart <= ?
       ORDER BY lastStart ASC, j.id ASC`,
    )
    .all(zombieCutoff) as { id: string; channel: string; lastStart: string }[]
  const strandedCutoff = new Date(now.getTime() - STRANDED_QUEUED_MS).toISOString()
  const strandedQueued = db
    .prepare(
      "SELECT id, channel FROM jobs WHERE deleted_at IS NULL AND status = 'queued' AND created_at <= ? ORDER BY created_at ASC",
    )
    .all(strandedCutoff) as { id: string; channel: string }[]
  const blockedJobs = db
    .prepare(
      "SELECT id, channel, budget_wait_json, retry_after FROM jobs WHERE deleted_at IS NULL AND status = 'blocked' ORDER BY created_at ASC, id ASC",
    )
    .all() as {
    id: string
    channel: string
    budget_wait_json: string | null
    retry_after: string | null
  }[]
  const inFlightJobCount = db.prepare(
    "SELECT COUNT(*) AS n FROM jobs WHERE deleted_at IS NULL AND channel = ? AND status IN ('running', 'queued')",
  )
  const claimedTopic = db.prepare(
    "SELECT id FROM topics WHERE job_id = ? AND status = 'claimed' ORDER BY id ASC",
  )
  const pendingByChannel = new Map<string, number>()
  const oldestByChannel = new Map<string, number | null>()
  const candidatesByChannel = new Map<string, number>()
  const claimedByChannel = new Map<string, number>()
  const inFlightByChannel = new Map<string, number>()
  for (const channel of channels) {
    if (channel.platforms.length === 0) continue
    const pending = pendingInventory(db, { channel: channel.name, declared: channel.platforms })
    pendingByChannel.set(channel.name, pending)
    if (pending > 0)
      oldestByChannel.set(channel.name, oldestUnpostedAge(db, channel.name, channel.platforms, now))
    if (channel.scout.subreddits.length === 0 || pending > 0) continue
    const candidates = candidateTopicCount(db, channel.name)
    candidatesByChannel.set(channel.name, candidates)
    if (candidates > 0) continue
    claimedByChannel.set(channel.name, claimedTopicCount(db, channel.name))
    inFlightByChannel.set(channel.name, (inFlightJobCount.get(channel.name) as { n: number }).n)
  }
  // Only the missing-config remedy offers a topic requeue, so only those
  // blocked jobs need their claimed topic looked up.
  const configured = new Set(channels.map((c) => c.name))
  const claimedTopicByJob = new Map<string, number>()
  for (const job of blockedJobs) {
    if (configured.has(job.channel)) continue
    const topic = claimedTopic.get(job.id) as { id: number } | undefined
    if (topic) claimedTopicByJob.set(job.id, topic.id)
  }
  return {
    channels,
    channelsError: opts.channelsError,
    topicRows,
    jobRows,
    spentByChannel,
    globalSpent: globalDaySpentMicros(db, day),
    globalCap: globalDailyCapMicros(),
    pendingByChannel,
    oldestByChannel,
    failedJobCount,
    failedJobs,
    zombies,
    strandedQueued,
    blockedJobs,
    claimedTopicByJob,
    candidatesByChannel,
    claimedByChannel,
    inFlightByChannel,
  }
}

export type DigestSnapshot = ReturnType<typeof collectDigest>
