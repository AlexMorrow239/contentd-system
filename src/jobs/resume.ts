import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { Database } from 'better-sqlite3'
import { loadChannelConfig } from '../config/channel.js'
import { markTopicUsedByJob } from '../scout/topics.js'
import { pipelineStages } from './pipeline.js'
import { runJob } from './runner.js'
import type { JobResult } from './runner.js'
import type { StageDef } from './types.js'

// A refusal to resume (missing job, non-resumable status, missing channel
// TOML) — distinct from a crash so the CLI prints just the reason and exits 1.
export class ResumeError extends Error {}

/**
 * Atomic resume claim: flip the job to 'running' only if it is still in a
 * status THIS call may resume — 'failed'/'blocked'/'queued' always, plus
 * 'running' when the operator forced a zombie takeover. One guarded UPDATE so
 * two concurrent resumers (a manual `resume` and a produce-next tick both
 * reading the same 'blocked'/'failed' job) cannot both proceed and double-spend;
 * the boolean is whether this call won the claim. Exported for direct coverage.
 */
export function claimJobForResume(db: Database, jobId: string, force: boolean): boolean {
  const statuses = force
    ? ['failed', 'blocked', 'queued', 'running']
    : ['failed', 'blocked', 'queued']
  const placeholders = statuses.map(() => '?').join(', ')
  const info = db
    .prepare(`UPDATE jobs SET status = 'running' WHERE id = ? AND status IN (${placeholders})`)
    .run(jobId, ...statuses)
  return info.changes === 1
}

export async function resumeJob(
  db: Database,
  jobId: string,
  opts: {
    runsRoot: string
    channelsDir: string
    force?: boolean
    stagesFor?: () => StageDef[]
    // Best-effort keep-alive for a caller's loop lease, fired at each stage
    // start. A resumed render is exactly as long as a fresh one — the produce
    // tick passes the same callback down both paths so neither can outlive the
    // lease and let the next cron firing start a second run on top of it. The
    // manual `resume` CLI holds no lease and passes nothing.
    heartbeat?: () => void
  },
): Promise<JobResult> {
  const job = db
    .prepare('SELECT channel, status FROM jobs WHERE id = ?')
    .get(jobId) as { channel: string; status: string } | undefined
  if (!job) {
    throw new ResumeError(`job not found: ${jobId}`)
  }
  if (job.status === 'done') {
    throw new ResumeError(`job ${jobId} is already done; nothing to resume`)
  }
  // 'queued' IS resumable: a crash (or SQLITE_BUSY) between produce-next's
  // claim transaction committing and runJob's first status write strands the
  // job 'queued' with every stage still pending — resuming it is simply a full
  // run. planTick ignores such jobs (it only surfaces 'blocked'), so without
  // this the strand would burn a quota slot invisibly forever; the digest
  // flags it (STRANDED_QUEUED_MS) so an operator knows to run `resume`.
  if (job.status === 'running' && !opts.force) {
    // 'running' usually means a live process holds the job; --force is the
    // operator asserting that process crashed (the digest flags such zombies).
    throw new ResumeError(`job ${jobId} is running; pass --force if no live process holds it`)
  }
  const channelPath = join(opts.channelsDir, `${job.channel}.toml`)
  if (!existsSync(channelPath)) {
    throw new ResumeError(`channel config not found: ${channelPath}`)
  }
  const channel = loadChannelConfig(channelPath)
  // The runner's skip-done-stages resume recovers the sunk cost; the stage
  // list is the exact produce wiring unless a test injects its own.
  const stages = opts.stagesFor?.() ?? pipelineStages()
  // Claim atomically AFTER every refusal above: the guards read status but
  // runJob's flip to 'running' was unconditional, so a manual resume and a tick
  // could both run one job. If another process already claimed it, refuse here
  // rather than double-spend; runJob's own later flip to 'running' is then a
  // same-value no-op.
  if (!claimJobForResume(db, jobId, opts.force ?? false)) {
    throw new ResumeError(`job ${jobId} was picked up by another process`)
  }
  const result = await runJob(db, channel, jobId, stages, {
    runsRoot: opts.runsRoot,
    heartbeat: opts.heartbeat,
  })
  // Library-landed (ready | needs-review) consumes the claimed topic; a
  // manual produce job has no claimed topic and this is a silent no-op.
  if (result.status === 'ready' || result.status === 'needs-review') {
    markTopicUsedByJob(db, jobId)
  }
  return result
}
