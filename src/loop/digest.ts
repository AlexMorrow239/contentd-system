import type { Database } from 'better-sqlite3'
import type { ChannelConfig } from '../config/channel.js'
import { channelDaySpentMicros, globalDailyCapMicros, globalDaySpentMicros } from '../jobs/costs.js'
import { pendingInventory, reclaimedUnreviewedJobs, unstoredLibraryJobs } from '../jobs/library.js'
import { candidateTopicCount } from '../scout/topics.js'
import type { Platform } from '../posts/types.js'
// ./config.js, not ./s3.js: this must not drag the AWS SDK onto the digest's
// startup path, same reasoning as produce-next.ts's own import of this.
import { s3ConfigError } from '../storage/config.js'
import { backlogCap } from './plan-tick.js'

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

// Display-only conversion — everything upstream stays integer micro-USD.
function usd(micros: number): string {
  return `$${(micros / 1e6).toFixed(2)}`
}

// Every list section prints its rows or a single placeholder line. Callers
// pass the placeholder verbatim rather than an indent depth, because the
// exact strings are pinned by digest.test.ts.
function pushNoneIfEmpty(lines: string[], sectionStart: number, noneLine: string): void {
  if (lines.length === sectionStart) lines.push(noneLine)
}

// Renders an age in whichever unit reads most naturally at that scale — days
// once something has been waiting a day or more (what the Posting section's
// "oldest" column needs), hours or minutes below that.
function formatAge(ms: number): string {
  if (ms >= 86_400_000) return `${String(Math.floor(ms / 86_400_000))}d`
  if (ms >= 3_600_000) return `${String(Math.floor(ms / 3_600_000))}h`
  return `${String(Math.floor(ms / 60_000))}m`
}

/**
 * How long the oldest unposted video in this channel has been waiting.
 * Same predicate as pendingInventory, deliberately — the count and the age
 * must describe the same set of rows.
 */
function oldestUnpostedAge(db: Database, channel: string, declared: readonly Platform[]): string {
  const marks = declared.map(() => '?').join(', ')
  const row = db
    .prepare(
      `SELECT MIN(l.created_at) AS oldest FROM library l JOIN jobs j ON j.id = l.job_id
       WHERE j.channel = ? AND l.state IN ('needs-review', 'ready')
         AND (SELECT COUNT(*) FROM posts p
              WHERE p.job_id = l.job_id AND p.platform IN (${marks})) < ?`,
    )
    .get(channel, ...declared, declared.length) as { oldest: string | null }
  return row.oldest === null ? '—' : formatAge(Date.now() - Date.parse(row.oldest))
}

/**
 * Last-24h operator report, plain multi-line text (NOT JSON), sections in
 * the plan's order: topics, jobs, spend, posting, action items. Count
 * sections group straight from sqlite so channels that vanished from the
 * channels dir still report; `channels` (the loadChannelsDir enumeration)
 * feeds the spend section and the channel-derived action items, both scoped
 * to channels carrying declared platforms. datetime(created_at) normalizes
 * the stored ISO-8601 'T'/'Z' format to sqlite's own datetime() format — a
 * raw string compare against datetime('now','-1 day') would widen the window
 * to the whole boundary day. `opts.channelsError` is the caller's way of
 * saying "the channels dir did not load": the sqlite-only sections still
 * report and the failure becomes an action item, rather than the whole
 * report collapsing to one error line on the morning it matters most.
 */
export function buildDigest(
  db: Database,
  channels: ChannelConfig[],
  opts: { channelsError?: string } = {},
): string {
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
    lines.push(
      `  ${r.channel}: ${r.scouted} scouted — of which ${r.candidate} candidate, ${r.rejected} rejected`,
    )
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

  // Posting: the manual operator's whole action list. A channel at its backlog
  // cap has stopped producing and will stay stopped until videos are posted or
  // discarded — the one condition nothing else in this report would surface,
  // since every other section is windowed to the last 24h and a halted channel
  // simply disappears from them.
  lines.push('', 'Posting')
  const sectionStart = lines.length
  for (const channel of channels) {
    if (channel.platforms.length === 0) continue
    const pending = pendingInventory(db, {
      channel: channel.name,
      declared: channel.platforms,
    })
    if (pending === 0) continue
    const oldest = oldestUnpostedAge(db, channel.name, channel.platforms)
    const held = pending >= backlogCap(channel) ? ' — production held' : ''
    lines.push(`  ${channel.name.padEnd(14)} ${pending} unposted (oldest ${oldest})${held}`)
  }
  pushNoneIfEmpty(lines, sectionStart, '  nothing waiting to post')

  lines.push('', 'Action items')
  const actionItemsStart = lines.length
  // First, because it explains every other section's silence: with no channels
  // loaded, spend, posting and the channel-derived action items below have
  // nothing to report and would otherwise read as "all clear".
  if (opts.channelsError !== undefined) {
    lines.push(
      `  the channels dir did not load (${opts.channelsError}) — spend, posting, and channel-derived action items are missing from this report`,
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
    .prepare(
      "SELECT id, channel FROM jobs WHERE status = 'blocked' ORDER BY created_at ASC, id ASC",
    )
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
  // Topic starvation: with autonomous supply (rss/generate), an empty topic
  // queue AND an empty backlog means the channel stops publishing when the
  // last scheduled video goes out — and every other line in this digest would
  // stay quiet about it. Channels with no scout sources are excluded: they
  // are fed by manual `brainrot produce`, where an empty queue is normal.
  const claimedTopicCount = db.prepare(
    "SELECT COUNT(*) AS n FROM topics WHERE channel = ? AND status = 'claimed'",
  )
  const inFlightJobCount = db.prepare(
    "SELECT COUNT(*) AS n FROM jobs WHERE channel = ? AND status IN ('running', 'queued')",
  )
  for (const c of channels) {
    const scoutsAnything =
      c.scout.subreddits.length + c.scout.rss.length + c.scout.generateTopics > 0
    if (!scoutsAnything || c.platforms.length === 0) continue
    const candidates = candidateTopicCount(db, c.name)
    const inventory = pendingInventory(db, {
      channel: c.name,
      declared: c.platforms,
    })
    if (candidates !== 0 || inventory !== 0) continue
    // 0 candidates and 0 inventory can still mean supply is moving, not
    // stopped: a claimed topic means a job is producing from it right now,
    // and a running/queued job means one is mid-pipeline even if its topic
    // claim isn't visible yet. Flagging either as starvation would be a false
    // alarm the first time it fires, which is what makes an operator start
    // ignoring the whole line.
    const claimed = (claimedTopicCount.get(c.name) as { n: number }).n
    const inFlight = (inFlightJobCount.get(c.name) as { n: number }).n
    // Safe to defer to a more specific alert here rather than hiding a real
    // wedge: every job state that can hold a topic claimed already has its
    // own digest line if it stalls — blocked, failed, zombie-running (past
    // ZOMBIE_RUNNING_MS), stranded-queued (past STRANDED_QUEUED_MS) — and a
    // job that finishes flips its topic to 'used' via the repair sweep, so it
    // can't linger here as a false "still moving" signal.
    if (claimed > 0 || inFlight > 0) continue
    lines.push(
      `  ${c.name}: topic starvation — 0 candidate topics and 0 unpublished videos; publishing stops when the backlog drains (check [scout] rss feeds / generate_topics)`,
    )
  }
  // A publishable library row with no stored object cannot reach Instagram:
  // publishMedia.url() has nothing to presign. The old check here was
  // existsSync on the local path, which is now NORMAL — runs/ is a disposable
  // cache and the bucket is the durable copy — and would fire constantly.
  // Shared with backfillStore so this line reports exactly the rows the
  // command it names will upload (src/jobs/library.ts).
  //
  // Gated on storage being configured: object storage is now OPTIONAL (the
  // `store` stage no-ops without it), so on a laptop-only deployment with no
  // bucket EVERY finished video has no `library_objects` row and this block
  // would tell the operator to run a command (`library backfill-store`) that
  // itself cannot run without storage. Same gate produce-next.ts already
  // applies to the reclaim sweep, for the identical reason.
  if (s3ConfigError() === undefined) {
    const unstored = unstoredLibraryJobs(db)
    for (const r of unstored) {
      lines.push(
        `  job ${r.jobId} (${r.channel}) has no stored object — run brainrot library backfill-store`,
      )
    }
  }
  // The other half of that story, and the accepted consequence of not exempting
  // needs-review from the reclaim sweep (design spec §3): a video nobody
  // reviewed in backlog_days had its bytes freed. `library approve` now refuses
  // it, so without this line it would sit as inventory nothing drains and
  // nothing reports.
  for (const r of reclaimedUnreviewedJobs(db)) {
    lines.push(
      `  job ${r.jobId} (${r.channel}) is still needs-review but its stored object was reclaimed — it can no longer publish; run brainrot library reject ${r.jobId}`,
    )
  }
  pushNoneIfEmpty(lines, actionItemsStart, '  none')

  return lines.join('\n')
}
