import type { Database } from 'better-sqlite3'
import type { ChannelConfig } from '../config/channel.js'
import {
  channelDaySpentMicros,
  globalDailyCapMicros,
  globalDaySpentMicros,
} from '../jobs/costs.js'
import { consumedSlots, MAX_PUBLISH_ATTEMPTS } from '../publish/publishes.js'
import { localDay } from '../publish/slots.js'
import { resolvePlatformMeta } from '../publish/types.js'
import type { Platform } from '../publish/types.js'

// A job 'running' longer than this has almost certainly lost its process —
// real runs finish in minutes. Digest-only visibility: auto-resume never
// touches running jobs; the operator resumes with --force.
export const ZOMBIE_RUNNING_MS = 7_200_000 // 2 h

// A job still 'queued' this long after creation was almost certainly stranded
// by a crash (or SQLITE_BUSY) between produce-next's claim transaction commit
// and runJob's first status write. resumeJob now accepts such jobs, but nothing
// auto-surfaces them (planTick only acts on 'blocked'), so the digest is the
// only place the strand becomes visible. Real runs flip off 'queued' in ms.
export const STRANDED_QUEUED_MS = 3_600_000 // 1 h

// Display-only conversion — everything upstream stays integer micro-USD.
function usd(micros: number): string {
  return `$${(micros / 1e6).toFixed(2)}`
}

/**
 * Last-24h operator report, plain multi-line text (NOT JSON), sections in
 * the plan's order: topics, jobs, spend, publishing, action items. Count
 * sections group straight from sqlite so channels that vanished from the
 * channels dir still report; `channels` (the loadChannelsDir enumeration)
 * feeds the spend section and the publish-config-aware action items (ready
 * backlog, lapsed slots), both scoped to channels carrying a `[publish]`
 * table. datetime(created_at) normalizes the stored ISO-8601 'T'/'Z' format
 * to sqlite's own datetime() format — a raw string compare against
 * datetime('now','-1 day') would widen the window to the whole boundary day.
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

  lines.push('', 'Publishing (last 24h)')
  // Same datetime() normalization as the topics/jobs sections above: stored
  // created_at is ISO-8601 with a 'T'/'Z' millis suffix, which sqlite's own
  // datetime('now', ...) doesn't emit — a raw string compare would widen
  // the window to the whole boundary day.
  const publishedRows = db
    .prepare(
      `SELECT p.channel AS channel, p.platform AS platform, p.slot AS slot,
              p.url AS url, j.topic AS topic, l.metadata_json AS metadataJson
       FROM publishes p
       JOIN jobs j ON j.id = p.job_id
       JOIN library l ON l.job_id = p.job_id
       WHERE p.status = 'done' AND datetime(p.created_at) >= datetime('now', '-1 day')
       ORDER BY p.channel, p.slot`,
    )
    .all() as {
    channel: string
    platform: Platform
    slot: string
    url: string
    topic: string
    metadataJson: string
  }[]
  lines.push('  Published:')
  if (publishedRows.length === 0) lines.push('    none')
  for (const r of publishedRows) {
    const meta = resolvePlatformMeta(r.metadataJson, r.platform, r.topic)
    lines.push(`    ${r.channel} ${r.slot} "${meta.title}" — ${r.url}`)
  }
  const failedPublishRows = db
    .prepare(
      `SELECT channel, slot, error_kind AS errorKind, error
       FROM publishes
       WHERE status = 'failed' AND datetime(created_at) >= datetime('now', '-1 day')
       ORDER BY channel, slot`,
    )
    .all() as { channel: string; slot: string; errorKind: string; error: string | null }[]
  lines.push('  Failed:')
  if (failedPublishRows.length === 0) lines.push('    none')
  for (const r of failedPublishRows) {
    lines.push(`    ${r.channel} ${r.slot} ${r.errorKind}: ${(r.error ?? '').slice(0, 80)}`)
  }
  // buildDigest is not clock-injected (no call site needs it); this single
  // now() read serves both the ready-backlog age just below and the
  // lapsed-slots 'yesterday' derivation in Action items.
  const now = new Date()
  // Ready-backlog pressure belongs in Publishing (spec §8), NOT Action items:
  // a lone just-produced video would otherwise stand as a daily action item
  // and habituate the operator to a non-empty section. Only channels that
  // actually publish count — ready rows on a channel with no [publish] table
  // just sit there by design.
  const readyBacklog = db
    .prepare(
      `SELECT j.channel AS channel, COUNT(*) AS n, MIN(l.created_at) AS oldest
       FROM library l JOIN jobs j ON j.id = l.job_id
       WHERE l.state = 'ready'
       GROUP BY j.channel`,
    )
    .all() as { channel: string; n: number; oldest: string }[]
  const publishingChannels = new Set(
    channels.filter((c) => c.publish !== null).map((c) => c.name),
  )
  const backlogStart = lines.length
  for (const r of readyBacklog) {
    if (!publishingChannels.has(r.channel)) continue
    const ageHours = Math.floor((now.getTime() - new Date(r.oldest).getTime()) / 3_600_000)
    lines.push(`  ${r.channel}: ${r.n} ready videos backlogged, oldest ${ageHours}h old`)
  }
  if (lines.length === backlogStart) lines.push('  none')

  lines.push('', 'Action items')
  const sectionStart = lines.length
  // Current state, not last-24h: a failed job awaits manual resume until the
  // operator acts, however old it is.
  const failedJobs = db
    .prepare("SELECT id, channel, tier FROM jobs WHERE status = 'failed' ORDER BY created_at ASC")
    .all() as { id: string; channel: string; tier: string }[]
  for (const j of failedJobs) {
    lines.push(`  failed job ${j.id} (${j.channel}, ${j.tier}) — resume manually`)
  }
  // Both sides are ISO-8601 UTC with millisecond 'Z' (schema default shape),
  // so a lexicographic compare is a time compare.
  const zombieCutoff = new Date(Date.now() - ZOMBIE_RUNNING_MS).toISOString()
  const zombies = db
    .prepare(
      "SELECT id, channel, tier FROM jobs WHERE status = 'running' AND created_at <= ? ORDER BY created_at ASC",
    )
    .all(zombieCutoff) as { id: string; channel: string; tier: string }[]
  for (const j of zombies) {
    lines.push(
      `  running job ${j.id} (${j.channel}, ${j.tier}) running > ${ZOMBIE_RUNNING_MS / 3_600_000}h — probably crashed — resume with --force`,
    )
  }
  // Same created_at age mechanism as the zombie check (ISO-8601 UTC, so a
  // lexicographic compare is a time compare): a job stuck 'queued' past the
  // threshold was stranded before its first status write and only resume can
  // recover it.
  const strandedCutoff = new Date(Date.now() - STRANDED_QUEUED_MS).toISOString()
  const strandedQueued = db
    .prepare(
      "SELECT id, channel, tier FROM jobs WHERE status = 'queued' AND created_at <= ? ORDER BY created_at ASC",
    )
    .all(strandedCutoff) as { id: string; channel: string; tier: string }[]
  for (const j of strandedQueued) {
    lines.push(
      `  queued job ${j.id} (${j.channel}, ${j.tier}) — stranded before start — resume with brainrot resume ${j.id}`,
    )
  }
  const approvedDepth = db
    .prepare(
      "SELECT channel, COUNT(*) AS n FROM topics WHERE status = 'approved' GROUP BY channel ORDER BY channel",
    )
    .all() as { channel: string; n: number }[]
  for (const r of approvedDepth) {
    lines.push(`  ${r.channel}: ${r.n} approved premium topics queued`)
  }
  const candidateDepth = db
    .prepare(
      "SELECT channel, COUNT(*) AS n FROM topics WHERE status = 'candidate' GROUP BY channel ORDER BY channel",
    )
    .all() as { channel: string; n: number }[]
  for (const r of candidateDepth) {
    lines.push(`  ${r.channel}: ${r.n} candidate topics awaiting approval`)
  }
  // Auth failures are channel-wide (the grant, not the video) — one hint
  // per channel rather than one per failed row, so a bad afternoon doesn't
  // spam identical suggestions.
  const authFailures = db
    .prepare(
      `SELECT channel, COUNT(*) AS n FROM publishes
       WHERE status = 'failed' AND error_kind = 'auth'
         AND datetime(created_at) >= datetime('now', '-1 day')
       GROUP BY channel ORDER BY channel`,
    )
    .all() as { channel: string; n: number }[]
  for (const r of authFailures) {
    lines.push(
      `  ${r.channel}: ${r.n} auth failures in the last 24h — run brainrot auth youtube --channel ${r.channel}`,
    )
  }
  // Quota failures mean the BRAINROT_YT_UPLOADS_PER_DAY estimate and
  // YouTube's real project quota disagree (spec §5: "cap vs reality
  // drift") — a distinct line per channel, mirroring the auth hint.
  const quotaFailures = db
    .prepare(
      `SELECT channel, COUNT(*) AS n FROM publishes
       WHERE status = 'failed' AND error_kind = 'quota'
         AND datetime(created_at) >= datetime('now', '-1 day')
       GROUP BY channel ORDER BY channel`,
    )
    .all() as { channel: string; n: number }[]
  for (const r of quotaFailures) {
    lines.push(
      `  ${r.channel}: ${r.n} quota failures in the last 24h — YouTube refused the upload; check BRAINROT_YT_UPLOADS_PER_DAY against the project's real quota`,
    )
  }
  // Current state, not last-24h (mirrors the failedJobs block above): an
  // interrupted upload sits until the operator checks Studio, however old.
  const interruptedRows = db
    .prepare(
      "SELECT job_id AS jobId, channel, slot FROM publishes WHERE status = 'interrupted' ORDER BY created_at ASC",
    )
    .all() as { jobId: string; channel: string; slot: string }[]
  for (const r of interruptedRows) {
    lines.push(
      `  interrupted publish ${r.jobId} (${r.channel}, ${r.slot}) — check YouTube Studio, then brainrot publish retry ${r.jobId} or brainrot publish mark-done ${r.jobId} <postId>`,
    )
  }
  // Only 'rejected' failures count toward the cap (decision 8) — auth/
  // quota/transient failures are channel- or platform-wide, not the
  // video's fault.
  const attemptCapped = db
    .prepare(
      `SELECT p.job_id AS jobId, p.channel AS channel, COUNT(*) AS n
       FROM publishes p JOIN library l ON l.job_id = p.job_id
       WHERE p.status = 'failed' AND p.error_kind = 'rejected' AND l.state = 'ready'
       GROUP BY p.job_id, p.channel
       HAVING COUNT(*) >= ?
       ORDER BY p.job_id`,
    )
    .all(MAX_PUBLISH_ATTEMPTS) as { jobId: string; channel: string; n: number }[]
  for (const r of attemptCapped) {
    lines.push(
      `  job ${r.jobId} (${r.channel}) hit the publish attempt cap (${r.n} rejected) — run brainrot library reject ${r.jobId}`,
    )
  }
  // Local-time slot bookkeeping (decision 13): "yesterday" is the local
  // calendar day before now — local date-field math, NOT now-minus-24h,
  // which lands on the wrong local date across DST transitions.
  const yesterdayDate = new Date(now)
  yesterdayDate.setDate(yesterdayDate.getDate() - 1)
  const yesterday = localDay(yesterdayDate)
  for (const channel of channels) {
    if (channel.publish === null) continue
    for (const platform of channel.publish.platforms) {
      const consumed = consumedSlots(db, channel.name, platform, yesterday)
      const lapsed = channel.publish.slots.filter((slot) => !consumed.has(slot))
      if (lapsed.length > 0) {
        lines.push(
          `  ${channel.name} ${platform}: slots ${lapsed.join(', ')} lapsed unfilled yesterday (${yesterday})`,
        )
      }
    }
  }
  if (lines.length === sectionStart) lines.push('  none')

  return lines.join('\n')
}
