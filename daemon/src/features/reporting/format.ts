import { formatUsdMicros } from '../../shared/money.js'
import { parseBudgetWait } from '../billing/budget-wait.js'
import { backlogCap } from '../library/capacity.js'
import { ZOMBIE_RUNNING_MS } from './policy.js'
import type { DigestSnapshot } from './queries.js'
function pushNoneIfEmpty(lines: string[], sectionStart: number, noneLine: string): void {
  if (lines.length === sectionStart) lines.push(noneLine)
}
function formatAge(ms: number): string {
  if (ms >= 86_400_000) return `${String(Math.floor(ms / 86_400_000))}d`
  if (ms >= 3_600_000) return `${String(Math.floor(ms / 3_600_000))}h`
  return `${String(Math.floor(ms / 60_000))}m`
}

/** Render an already-collected report without database or clock access. */
export function formatDigest(snapshot: DigestSnapshot): string {
  const {
    channels,
    channelsError,
    topicRows,
    jobRows,
    spentByChannel,
    globalSpent,
    globalCap,
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
  } = snapshot

  const lines: string[] = []

  lines.push('Topics (last 24h)')
  const topicsStart = lines.length
  for (const r of topicRows) {
    lines.push(
      `  ${r.channel}: ${r.scouted} scouted — of which ${r.candidate} candidate, ${r.rejected} rejected`,
    )
  }
  pushNoneIfEmpty(lines, topicsStart, '  none')

  lines.push('', 'Jobs (last 24h)')
  const jobsStart = lines.length
  for (const r of jobRows) {
    lines.push(
      `  ${r.channel}: ${r.total} — ${r.ready} ready, ${r.needsReview} needs-review, ${r.failed} failed, ${r.blocked} blocked`,
    )
  }
  pushNoneIfEmpty(lines, jobsStart, '  none')

  lines.push('', 'Spend today (UTC; includes estimates)')
  for (const channel of channels) {
    lines.push(
      `  ${channel.name}: ${formatUsdMicros(spentByChannel.get(channel.name) ?? 0)} ${channel.budget === undefined ? '— Global limit only' : `of ${formatUsdMicros(channel.budget.perDayUsdMicros)}`}`,
    )
  }
  lines.push(`  global: ${formatUsdMicros(globalSpent)} of ${formatUsdMicros(globalCap)}`)

  // Posting: the manual operator's whole action list. A channel at its backlog
  // cap has stopped producing and will stay stopped until videos are posted or
  // discarded — the one condition nothing else in this report would surface,
  // since every other section is windowed to the last 24h and a halted channel
  // simply disappears from them.
  lines.push('', 'Posting')
  const sectionStart = lines.length
  for (const channel of channels) {
    if (channel.platforms.length === 0) continue
    const pending = pendingByChannel.get(channel.name) ?? 0
    if (pending === 0) continue
    const oldest =
      oldestByChannel.get(channel.name) == null
        ? '—'
        : formatAge(oldestByChannel.get(channel.name)!)
    const held = pending >= backlogCap(channel) ? ' — production held' : ''
    lines.push(`  ${channel.name.padEnd(14)} ${pending} unposted (oldest ${oldest})${held}`)
  }
  pushNoneIfEmpty(lines, sectionStart, '  nothing waiting to post')

  lines.push('', 'Action items')
  const actionItemsStart = lines.length
  // First, because it explains every other section's silence: with no channels
  // loaded, spend, posting and the channel-derived action items below have
  // nothing to report and would otherwise read as "all clear".
  if (channelsError !== undefined) {
    lines.push(
      `  the channels dir did not load (${channelsError}) — spend, posting, and channel-derived action items are missing from this report`,
    )
  }
  for (const j of failedJobs) {
    lines.push(`  failed job ${j.id} (${j.channel}) — resume manually`)
  }
  if (failedJobCount > failedJobs.length) {
    lines.push(`  and ${failedJobCount - failedJobs.length} older failures`)
  }
  for (const j of zombies) {
    lines.push(
      `  running job ${j.id} (${j.channel}) running > ${ZOMBIE_RUNNING_MS / 3_600_000}h — probably crashed — resume with --force`,
    )
  }
  for (const j of strandedQueued) {
    lines.push(
      `  queued job ${j.id} (${j.channel}) — stranded before start — resume with brainrot resume ${j.id}`,
    )
  }
  if (blockedJobs.length > 0) {
    const byName = new Map(channels.map((c) => [c.name, c]))
    const orAbandon = (jobId: string): string => {
      const topic = claimedTopicByJob.get(jobId)
      return topic === undefined ? '' : `, or free its topic with brainrot topics requeue ${topic}`
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
      const wait = parseBudgetWait(j.budget_wait_json)
      if (wait !== null) {
        const estimate =
          wait.details === null
            ? ''
            : ` — next call ${formatUsdMicros(wait.details.upcomingUsdMicros)}; recorded spend ${formatUsdMicros(wait.details.spentUsdMicros)} of ${formatUsdMicros(wait.details.capUsdMicros)} ${wait.details.scope} cap`
        const retry =
          j.retry_after === null ? '' : ` — next eligibility check no earlier than ${j.retry_after}`
        lines.push(`${head} — budget wait at ${wait.stage}: ${wait.reason}${estimate}${retry}`)
        continue
      }
      lines.push(`${head} — awaiting eligibility under current daily budgets`)
    }
  }
  for (const c of channels) {
    if (c.scout.subreddits.length === 0 || c.platforms.length === 0) continue
    const candidates = candidatesByChannel.get(c.name) ?? 0
    const inventory = pendingByChannel.get(c.name) ?? 0
    if (candidates !== 0 || inventory !== 0) continue
    // 0 candidates and 0 inventory can still mean supply is moving, not
    // stopped: a claimed topic means a job is producing from it right now,
    // and a running/queued job means one is mid-pipeline even if its topic
    // claim isn't visible yet. Flagging either as starvation would be a false
    // alarm the first time it fires, which is what makes an operator start
    // ignoring the whole line.
    const claimed = claimedByChannel.get(c.name) ?? 0
    const inFlight = inFlightByChannel.get(c.name) ?? 0
    // Safe to defer to a more specific alert here rather than hiding a real
    // wedge: every job state that can hold a topic claimed already has its
    // own digest line if it stalls — blocked, failed, zombie-running (past
    // ZOMBIE_RUNNING_MS), stranded-queued (past STRANDED_QUEUED_MS) — and a
    // job that finishes flips its topic to 'used' inside runJob's final-gate
    // transaction, so it can't linger here as a false "still moving" signal.
    if (claimed > 0 || inFlight > 0) continue
    lines.push(
      `  ${c.name}: topic starvation — 0 candidate topics and 0 unpublished videos; publishing stops when the backlog drains (check [scout] subreddits and https://status.arctic-shift.photon-reddit.com)`,
    )
  }
  pushNoneIfEmpty(lines, actionItemsStart, '  none')

  return lines.join('\n')
}
