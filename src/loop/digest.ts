import type { Database } from 'better-sqlite3'
import type { ChannelConfig } from '../config/channel.js'
import {
  channelDaySpentMicros,
  globalDailyCapMicros,
  globalDaySpentMicros,
} from '../jobs/costs.js'

// A job 'running' longer than this has almost certainly lost its process —
// real runs finish in minutes. Digest-only visibility: auto-resume never
// touches running jobs; the operator resumes with --force.
export const ZOMBIE_RUNNING_MS = 7_200_000 // 2 h

// Display-only conversion — everything upstream stays integer micro-USD.
function usd(micros: number): string {
  return `$${(micros / 1e6).toFixed(2)}`
}

/**
 * Last-24h operator report, plain multi-line text (NOT JSON), sections in
 * the plan's order: topics, jobs, spend, action items. Count sections group
 * straight from sqlite so channels that vanished from the channels dir still
 * report; `channels` (the loadChannelsDir enumeration) feeds only the spend
 * section, whose caps live in the TOMLs. datetime(created_at) normalizes the
 * stored ISO-8601 'T'/'Z' format to sqlite's own datetime() format — a raw
 * string compare against datetime('now','-1 day') would widen the window to
 * the whole boundary day.
 */
export function buildDigest(db: Database, channels: ChannelConfig[]): string {
  const lines: string[] = []

  lines.push('Topics (last 24h)')
  const topicRows = db
    .prepare(
      `SELECT channel, COUNT(*) AS scouted,
              SUM(CASE WHEN status = 'candidate' THEN 1 ELSE 0 END) AS candidate,
              SUM(CASE WHEN status = 'approved' THEN 1 ELSE 0 END) AS approved,
              SUM(CASE WHEN status = 'rejected' THEN 1 ELSE 0 END) AS rejected
       FROM topics WHERE datetime(created_at) >= datetime('now', '-1 day')
       GROUP BY channel ORDER BY channel`,
    )
    .all() as {
    channel: string
    scouted: number
    candidate: number
    approved: number
    rejected: number
  }[]
  if (topicRows.length === 0) lines.push('  none')
  for (const r of topicRows) {
    lines.push(
      `  ${r.channel}: ${r.scouted} scouted — ${r.candidate} candidate, ${r.approved} approved, ${r.rejected} rejected`,
    )
  }

  lines.push('', 'Jobs (last 24h)')
  // 'done' jobs resolve to ready/needs-review through their library row;
  // failed/blocked read straight off jobs.status. queued/running jobs count
  // toward the total but have no outcome yet.
  const jobRows = db
    .prepare(
      `SELECT j.channel, j.tier, COUNT(*) AS total,
              SUM(CASE WHEN l.state = 'ready' THEN 1 ELSE 0 END) AS ready,
              SUM(CASE WHEN l.state = 'needs-review' THEN 1 ELSE 0 END) AS needsReview,
              SUM(CASE WHEN j.status = 'failed' THEN 1 ELSE 0 END) AS failed,
              SUM(CASE WHEN j.status = 'blocked' THEN 1 ELSE 0 END) AS blocked
       FROM jobs j LEFT JOIN library l ON l.job_id = j.id
       WHERE datetime(j.created_at) >= datetime('now', '-1 day')
       GROUP BY j.channel, j.tier ORDER BY j.channel, j.tier`,
    )
    .all() as {
    channel: string
    tier: string
    total: number
    ready: number
    needsReview: number
    failed: number
    blocked: number
  }[]
  if (jobRows.length === 0) lines.push('  none')
  for (const r of jobRows) {
    lines.push(
      `  ${r.channel} ${r.tier}: ${r.total} — ${r.ready} ready, ${r.needsReview} needs-review, ${r.failed} failed, ${r.blocked} blocked`,
    )
  }

  lines.push('', 'Spend today (UTC)')
  for (const channel of channels) {
    lines.push(
      `  ${channel.name}: ${usd(channelDaySpentMicros(db, channel.name))} of ${usd(channel.budget.perDayUsdMicros)}`,
    )
  }
  lines.push(`  global: ${usd(globalDaySpentMicros(db))} of ${usd(globalDailyCapMicros())}`)

  return lines.join('\n')
}
