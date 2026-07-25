import { existsSync } from 'node:fs'
import type { Database } from 'better-sqlite3'
import type { ChannelConfig } from '../config/channel.js'
import {
  channelDaySpentMicros,
  globalDailyCapMicros,
  globalDaySpentMicros,
} from '../jobs/costs.js'
import { parseTokenKey } from '../publish/crypto.js'
import { consumedSlots, MAX_PUBLISH_ATTEMPTS } from '../publish/publishes.js'
import { localDay } from '../publish/slots.js'
import { loadRefreshToken } from '../publish/tokens.js'
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

// Failures are listed newest-first-window, oldest-first-printed: past this
// many, fresh failures would be buried under a wall of history the operator
// has already seen. The remainder is still counted, never silently dropped.
export const FAILED_JOBS_LIMIT = 10

/**
 * Environment facts the digest reports on. Read from process.env by default
 * (the cli passes nothing) so the digest can name a missing key as the reason
 * work is stuck; tests override each field explicitly rather than depending on
 * the developer's own .env. Only presence is ever carried for the secrets —
 * the token key hex is needed to attempt a decrypt and is never printed.
 */
export interface DigestEnv {
  ytClientIdPresent: boolean
  ytClientSecretPresent: boolean
  tokenKeyHex: string | undefined
}

// `in` rather than `??` for tokenKeyHex: a test passing an explicit undefined
// means "unset", which `??` would quietly replace with the real environment.
function resolveDigestEnv(overrides: Partial<DigestEnv>): DigestEnv {
  const tokenKeyHex = process.env.BRAINROT_TOKEN_KEY
  return {
    ytClientIdPresent: overrides.ytClientIdPresent ?? !!process.env.YT_CLIENT_ID,
    ytClientSecretPresent: overrides.ytClientSecretPresent ?? !!process.env.YT_CLIENT_SECRET,
    tokenKeyHex: 'tokenKeyHex' in overrides
      ? overrides.tokenKeyHex
      : tokenKeyHex === undefined || tokenKeyHex === '' ? undefined : tokenKeyHex,
  }
}

// Display-only conversion — everything upstream stays integer micro-USD.
function usd(micros: number): string {
  return `$${(micros / 1e6).toFixed(2)}`
}

// Every list section prints its rows or a single placeholder line. Callers
// pass the placeholder verbatim rather than an indent depth, because the
// depth is not uniform: Publishing's subsections nest one level deeper than
// the top-level sections, and the exact strings are pinned by digest.test.ts.
function pushNoneIfEmpty(lines: string[], sectionStart: number, noneLine: string): void {
  if (lines.length === sectionStart) lines.push(noneLine)
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
 * `env` exists for tests only — production callers pass nothing and the
 * environment is read here. `opts.channelsError` is the caller's way of saying
 * "the channels dir did not load": the sqlite-only sections still report and
 * the failure becomes an action item, rather than the whole report collapsing
 * to one error line on the morning it matters most.
 */
export function buildDigest(
  db: Database,
  channels: ChannelConfig[],
  env: Partial<DigestEnv> = {},
  opts: { channelsError?: string } = {},
): string {
  const digestEnv = resolveDigestEnv(env)
  const lines: string[] = []

  lines.push('Topics (last 24h)')
  const topicRows = db
    .prepare(
      `SELECT channel, COUNT(*) AS scouted,
              SUM(CASE WHEN status = 'candidate' THEN 1 ELSE 0 END) AS candidate,
              SUM(CASE WHEN status = 'rejected' THEN 1 ELSE 0 END) AS rejected
       FROM topics WHERE datetime(created_at) >= datetime('now', '-1 day')
       GROUP BY channel ORDER BY channel`,
    )
    .all() as {
    channel: string
    scouted: number
    candidate: number
    rejected: number
  }[]
  const topicsStart = lines.length
  for (const r of topicRows) {
    lines.push(`  ${r.channel}: ${r.scouted} scouted — ${r.candidate} candidate, ${r.rejected} rejected`)
  }
  pushNoneIfEmpty(lines, topicsStart, '  none')

  lines.push('', 'Jobs (last 24h)')
  // 'done' jobs resolve to ready/needs-review through their library row;
  // failed/blocked read straight off jobs.status. queued/running jobs count
  // toward the total but have no outcome yet.
  const jobRows = db
    .prepare(
      `SELECT j.channel, COUNT(*) AS total,
              SUM(CASE WHEN l.state = 'ready' THEN 1 ELSE 0 END) AS ready,
              SUM(CASE WHEN l.state = 'needs-review' THEN 1 ELSE 0 END) AS needsReview,
              SUM(CASE WHEN j.status = 'failed' THEN 1 ELSE 0 END) AS failed,
              SUM(CASE WHEN j.status = 'blocked' THEN 1 ELSE 0 END) AS blocked
       FROM jobs j LEFT JOIN library l ON l.job_id = j.id
       WHERE datetime(j.created_at) >= datetime('now', '-1 day')
       GROUP BY j.channel ORDER BY j.channel`,
    )
    .all() as {
    channel: string
    total: number
    ready: number
    needsReview: number
    failed: number
    blocked: number
  }[]
  const jobsStart = lines.length
  for (const r of jobRows) {
    lines.push(
      `  ${r.channel}: ${r.total} — ${r.ready} ready, ${r.needsReview} needs-review, ${r.failed} failed, ${r.blocked} blocked`,
    )
  }
  pushNoneIfEmpty(lines, jobsStart, '  none')

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
  const publishedStart = lines.length
  for (const r of publishedRows) {
    const meta = resolvePlatformMeta(r.metadataJson, r.platform, r.topic)
    lines.push(`    ${r.channel} ${r.slot} "${meta.title}" — ${r.url}`)
  }
  pushNoneIfEmpty(lines, publishedStart, '    none')
  const failedPublishRows = db
    .prepare(
      `SELECT channel, slot, error_kind AS errorKind, error
       FROM publishes
       WHERE status = 'failed' AND datetime(created_at) >= datetime('now', '-1 day')
       ORDER BY channel, slot`,
    )
    .all() as { channel: string; slot: string; errorKind: string; error: string | null }[]
  lines.push('  Failed:')
  const failedStart = lines.length
  for (const r of failedPublishRows) {
    lines.push(`    ${r.channel} ${r.slot} ${r.errorKind}: ${(r.error ?? '').slice(0, 80)}`)
  }
  pushNoneIfEmpty(lines, failedStart, '    none')
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
  lines.push('  Backlog:')
  const backlogStart = lines.length
  for (const r of readyBacklog) {
    if (!publishingChannels.has(r.channel)) continue
    const ageHours = Math.floor((now.getTime() - new Date(r.oldest).getTime()) / 3_600_000)
    lines.push(`    ${r.channel}: ${r.n} ready videos backlogged, oldest ${ageHours}h old`)
  }
  pushNoneIfEmpty(lines, backlogStart, '    none')

  lines.push('', 'Action items')
  const actionItemsStart = lines.length
  // First, because it explains every other section's silence: with no channels
  // loaded, spend, publishing and the channel-derived action items below have
  // nothing to report and would otherwise read as "all clear".
  if (opts.channelsError !== undefined) {
    lines.push(
      `  the channels dir did not load (${opts.channelsError}) — spend, publishing, and channel-derived action items are missing from this report`,
    )
  }
  // Current state, not last-24h: a failed job awaits manual resume until the
  // operator acts, however old it is. Only the newest FAILED_JOBS_LIMIT are
  // listed (selected newest-first, then reversed back to the oldest-first
  // print order the uncapped list used), with the remainder counted below.
  const failedJobCount = (
    db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE status = 'failed'").get() as { n: number }
  ).n
  const failedJobs = (
    db
      .prepare(
        "SELECT id, channel FROM jobs WHERE status = 'failed' ORDER BY created_at DESC, id DESC LIMIT ?",
      )
      .all(FAILED_JOBS_LIMIT) as { id: string; channel: string }[]
  ).reverse()
  for (const j of failedJobs) {
    lines.push(`  failed job ${j.id} (${j.channel}) — resume manually`)
  }
  if (failedJobCount > failedJobs.length) {
    lines.push(`  and ${failedJobCount - failedJobs.length} older failures`)
  }
  // Age from the latest stage start, falling back to created_at for a job
  // that never reached its first stage: a job created yesterday and resumed
  // minutes ago is live, and telling the operator to resume it with --force
  // would double-run the render. Both sides are ISO-8601 UTC with millisecond
  // 'Z' (schema default shape), so a lexicographic compare is a time compare.
  const zombieCutoff = new Date(Date.now() - ZOMBIE_RUNNING_MS).toISOString()
  const zombies = db
    .prepare(
      `SELECT j.id AS id, j.channel AS channel,
              COALESCE(MAX(s.started_at), j.created_at) AS lastStart
       FROM jobs j LEFT JOIN job_stages s ON s.job_id = j.id
       WHERE j.status = 'running'
       GROUP BY j.id, j.channel, j.created_at
       HAVING lastStart <= ?
       ORDER BY lastStart ASC, j.id ASC`,
    )
    .all(zombieCutoff) as { id: string; channel: string; lastStart: string }[]
  for (const j of zombies) {
    lines.push(
      `  running job ${j.id} (${j.channel}) running > ${ZOMBIE_RUNNING_MS / 3_600_000}h — probably crashed — resume with --force`,
    )
  }
  // Same created_at age mechanism as the zombie check (ISO-8601 UTC, so a
  // lexicographic compare is a time compare): a job stuck 'queued' past the
  // threshold was stranded before its first status write and only resume can
  // recover it.
  const strandedCutoff = new Date(Date.now() - STRANDED_QUEUED_MS).toISOString()
  const strandedQueued = db
    .prepare(
      "SELECT id, channel FROM jobs WHERE status = 'queued' AND created_at <= ? ORDER BY created_at ASC",
    )
    .all(strandedCutoff) as { id: string; channel: string }[]
  for (const j of strandedQueued) {
    lines.push(
      `  queued job ${j.id} (${j.channel}) — stranded before start — resume with brainrot resume ${j.id}`,
    )
  }
  // Blocked jobs are current-state too, and unlike the counts above they are
  // NOT 24h-windowed: config drift (channel TOML gone, the per-video cap
  // fully spent) excludes a job from the resume pass forever, and after a
  // day it would otherwise vanish from every operator surface with its spend
  // sunk and its topic still 'claimed'.
  const blockedJobs = db
    .prepare("SELECT id, channel FROM jobs WHERE status = 'blocked' ORDER BY created_at ASC, id ASC")
    .all() as { id: string; channel: string }[]
  if (blockedJobs.length > 0) {
    const byName = new Map(channels.map((c) => [c.name, c]))
    // Lifetime spend, mirroring the per-video check in assertBudget: the cap
    // is never reset by a day boundary, so a spent-out job never self-heals.
    const jobSpent = db.prepare(
      'SELECT COALESCE(SUM(usd_micros), 0) AS total FROM costs WHERE job_id = ?',
    )
    // The other half of every dead-end remedy below: a blocked job usually
    // still holds the topic it claimed, and `topics requeue` (which now
    // accepts a blocked job's topic) puts that trend back in the queue for a
    // healthy job. Named with the concrete topic id, since the command takes
    // one and the operator only has the job id from this line. Omitted when
    // the job holds no claimed topic — a hand-run `produce` never claims one.
    const claimedTopic = db.prepare(
      "SELECT id FROM topics WHERE job_id = ? AND status = 'claimed' ORDER BY id ASC",
    )
    const orAbandon = (jobId: string): string => {
      const topic = claimedTopic.get(jobId) as { id: number } | undefined
      return topic === undefined
        ? ''
        : `, or free its topic with brainrot topics requeue ${topic.id}`
    }
    for (const j of blockedJobs) {
      const head = `  blocked job ${j.id} (${j.channel})`
      const channel = byName.get(j.channel)
      if (channel === undefined) {
        lines.push(
          `${head} — no channel config named ${j.channel} in the channels dir — restore ${j.channel}.toml then brainrot resume ${j.id}${orAbandon(j.id)}`,
        )
        continue
      }
      const capMicros = channel.budget.perVideoUsdMicros
      const spentMicros = (jobSpent.get(j.id) as { total: number }).total
      if (spentMicros >= capMicros) {
        lines.push(
          `${head} — per-video budget spent (${usd(spentMicros)} of ${usd(capMicros)}) — raise the cap in ${j.channel}.toml then brainrot resume ${j.id}${orAbandon(j.id)}`,
        )
        continue
      }
      lines.push(
        `${head} — ${usd(capMicros - spentMicros)} of its ${usd(capMicros)} per-video budget left — awaiting the resume pass`,
      )
    }
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
  // Token health per publish-enabled channel. A missing grant, a rotated
  // BRAINROT_TOKEN_KEY, or unset client credentials all make every publish
  // tick a `no-auth` noop that writes no publishes row — so the auth hint
  // above (which counts failed rows) can never fire, and the only other
  // signal is a lapsed slot a full day later with no cause named. Names
  // only: neither key nor token bytes are ever read into a line here.
  if (channels.some((c) => c.publish !== null)) {
    const unsetVars: string[] = []
    if (!digestEnv.ytClientIdPresent) unsetVars.push('YT_CLIENT_ID')
    if (!digestEnv.ytClientSecretPresent) unsetVars.push('YT_CLIENT_SECRET')
    if (digestEnv.tokenKeyHex === undefined) unsetVars.push('BRAINROT_TOKEN_KEY')
    if (unsetVars.length > 0) {
      lines.push(
        `  publishing is not configured: ${unsetVars.join(', ')} unset — every publish tick noops with reason no-auth`,
      )
    }
    // A set-but-malformed key is its own failure mode: the rows exist and
    // look fine, nothing can open them. parseTokenKey's message names no
    // value, and neither does this line.
    let tokenKey: Buffer | undefined
    if (digestEnv.tokenKeyHex !== undefined) {
      try {
        tokenKey = parseTokenKey(digestEnv.tokenKeyHex)
      } catch {
        lines.push(
          '  BRAINROT_TOKEN_KEY is set but is not 64 hex characters — stored tokens cannot be decrypted',
        )
      }
    }
    const tokenRow = db.prepare(
      'SELECT 1 AS present FROM oauth_tokens WHERE platform = ? AND channel = ?',
    )
    for (const channel of channels) {
      if (channel.publish === null) continue
      for (const platform of channel.publish.platforms) {
        const remedy = `run brainrot auth ${platform} --channel ${channel.name}`
        if (tokenRow.get(platform, channel.name) === undefined) {
          lines.push(`  ${channel.name} ${platform}: no stored token — ${remedy}`)
          continue
        }
        // With no usable key the decrypt cannot be attempted; the unset /
        // malformed line above already names that cause.
        if (tokenKey === undefined) continue
        if (loadRefreshToken(db, platform, channel.name, tokenKey) === null) {
          lines.push(
            `  ${channel.name} ${platform}: the stored token does not decrypt with the current BRAINROT_TOKEN_KEY — ${remedy}`,
          )
        }
      }
    }
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
  // A ready row whose file was pruned from runs/ can never publish: the tick
  // skips it, and without this line the operator sees only a backlog that
  // never drains. Pure read — existsSync on the path the publish tick would
  // open — so the digest stays side-effect free.
  const readyVideos = db
    .prepare(
      `SELECT l.job_id AS jobId, j.channel AS channel, l.video_path AS videoPath
       FROM library l JOIN jobs j ON j.id = l.job_id
       WHERE l.state = 'ready' ORDER BY l.job_id`,
    )
    .all() as { jobId: string; channel: string; videoPath: string }[]
  for (const r of readyVideos) {
    if (existsSync(r.videoPath)) continue
    lines.push(
      `  ready job ${r.jobId} (${r.channel}) has no video file at ${r.videoPath} — run brainrot library reject ${r.jobId}`,
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
  pushNoneIfEmpty(lines, actionItemsStart, '  none')

  return lines.join('\n')
}
