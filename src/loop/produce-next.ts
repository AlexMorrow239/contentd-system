import type { Database } from 'better-sqlite3'
import { loadChannelsDir } from '../config/channel.js'
import { stagesForTier } from '../jobs/pipeline.js'
import { ResumeError, resumeJob } from '../jobs/resume.js'
import { createJob, runJob } from '../jobs/runner.js'
import type { JobResult } from '../jobs/runner.js'
import type { StageDef, Tier } from '../jobs/types.js'
import { claimTopic, markTopicUsedByJob } from '../scout/topics.js'
import { acquireLease, extendLease, PRODUCE_LEASE_TTL_MS, releaseLease } from './lease.js'
import { planTick } from './plan-tick.js'

export interface TickResult {
  action: 'resumed' | 'produced' | 'noop'
  reason?: 'lease-held' | 'no-eligible-work' | 'no-fal-key' | 'claim-conflict'
  jobId?: string
  topicId?: number
  tier?: Tier
  status?: JobResult['status']
}

// The topic slipped away between planning and claiming. Its own class so the
// claim transaction's rollback throw stays distinguishable from a real crash.
class ClaimConflictError extends Error {}

/**
 * One unit of work per invocation: resume the planner's blocked job, or claim
 * one topic and produce it. Cron cadence controls throughput — this function
 * never loops.
 */
export async function produceNextTick(
  db: Database,
  opts: {
    channelsDir: string
    runsRoot: string
    stagesFor?: (tier: Tier) => StageDef[]
  },
): Promise<TickResult> {
  const stagesFor = opts.stagesFor ?? stagesForTier
  // A held lease is the NORMAL case while a long render from the previous
  // cron firing is still running — benign no-op, exit 0 at the CLI. The
  // pid-tagged holder means an expiry takeover can never be released by the
  // evicted process (releaseLease matches on holder).
  const holder = `pid:${process.pid}`
  if (!acquireLease(db, 'produce', holder, PRODUCE_LEASE_TTL_MS)) {
    return { action: 'noop', reason: 'lease-held' }
  }
  try {
    const channels = loadChannelsDir(opts.channelsDir)
    // Repair sweep (heals the crash window between runJob committing the library
    // row and markTopicUsedByJob running): a topic left 'claimed' but bound to a
    // job that already landed in the library would stay claimed forever — resume
    // refuses a 'done' job, so nothing else can recover it. Idempotent and cheap;
    // run it inside the lease before planning this tick.
    db.prepare(
      "UPDATE topics SET status = 'used' WHERE status = 'claimed' AND job_id IN (SELECT job_id FROM library)",
    ).run()
    const plan = planTick(db, channels, { falKeyPresent: !!process.env.FAL_KEY })

    if (plan.kind === 'noop') {
      return { action: 'noop', reason: plan.reason }
    }

    if (plan.kind === 'resume') {
      // planTick only surfaces blocked jobs, so force stays unset: taking
      // over a 'running' job is an operator decision, never the loop's.
      let result: JobResult
      try {
        result = await resumeJob(db, plan.jobId, {
          runsRoot: opts.runsRoot,
          channelsDir: opts.channelsDir,
          stagesFor,
        })
      } catch (err) {
        // A ResumeError is a refusal, not a crash: an operator's `resume` (or
        // `topics reject`) won the job between planning and claiming it. Report
        // the benign, self-healing race the way publish-next does — one JSON
        // line, exit 0 — instead of a stack trace every cron firing.
        if (err instanceof ResumeError) {
          return { action: 'noop', reason: 'claim-conflict' }
        }
        throw err
      }
      return { action: 'resumed', jobId: plan.jobId, tier: plan.tier, status: result.status }
    }

    const channel = channels.find((c) => c.name === plan.channel)
    if (channel === undefined) {
      throw new Error(`planTick chose a channel missing from the loaded set: ${plan.channel}`)
    }
    // createJob + claimTopic commit atomically: a crash between them can
    // neither orphan a queued job nor leave the topic unbound, and a false
    // claim (invariant breach — planTick selected this topic under this very
    // lease) rolls the job row back via the throw. better-sqlite3 nests
    // createJob's internal transaction as a savepoint, so the wrap is safe.
    let jobId: string
    try {
      jobId = db.transaction(() => {
        const id = createJob(db, channel, { topic: plan.topic, tier: plan.tier })
        if (!claimTopic(db, plan.topicId, id)) {
          throw new ClaimConflictError(
            `topic ${plan.topicId} is no longer claimable (status changed since planning)`,
          )
        }
        return id
      })()
    } catch (err) {
      // `topics reject` landing inside the plan→claim window: the job row rolled
      // back with the throw and the next tick simply plans again.
      if (err instanceof ClaimConflictError) {
        return { action: 'noop', reason: 'claim-conflict' }
      }
      throw err
    }
    const result = await runJob(db, channel, jobId, stagesFor(plan.tier), {
      runsRoot: opts.runsRoot,
      // A render longer than the lease TTL would otherwise let the next cron
      // firing start a second tick on top of this one. extendLease matches on
      // holder, so a lease already taken over is never re-acquired here.
      heartbeat: () => {
        extendLease(db, 'produce', holder, PRODUCE_LEASE_TTL_MS)
      },
    })
    if (result.status === 'ready' || result.status === 'needs-review') {
      // Library-landed is the only used-flip: a failed/blocked job keeps its
      // topic 'claimed' and bound to the job — the resume path owns recovery,
      // so the topic is never re-claimed or lost.
      markTopicUsedByJob(db, jobId)
    }
    return { action: 'produced', jobId, topicId: plan.topicId, tier: plan.tier, status: result.status }
  } finally {
    releaseLease(db, 'produce', holder)
  }
}
