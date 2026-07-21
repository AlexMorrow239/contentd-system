import type { Database } from 'better-sqlite3'
import { loadChannelsDir } from '../config/channel.js'
import { stagesForTier } from '../jobs/pipeline.js'
import { resumeJob } from '../jobs/resume.js'
import { createJob, runJob } from '../jobs/runner.js'
import type { JobResult } from '../jobs/runner.js'
import type { StageDef, Tier } from '../jobs/types.js'
import { claimTopic, markTopicUsedByJob } from '../scout/topics.js'
import { acquireLease, PRODUCE_LEASE_TTL_MS, releaseLease } from './lease.js'
import { planTick } from './plan-tick.js'

export interface TickResult {
  action: 'resumed' | 'produced' | 'noop'
  reason?: 'lease-held' | 'no-eligible-work' | 'no-fal-key'
  jobId?: string
  topicId?: number
  tier?: Tier
  status?: JobResult['status']
}

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
      const result = await resumeJob(db, plan.jobId, {
        runsRoot: opts.runsRoot,
        channelsDir: opts.channelsDir,
        stagesFor,
      })
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
    const jobId = db.transaction(() => {
      const id = createJob(db, channel, { topic: plan.topic, tier: plan.tier })
      if (!claimTopic(db, plan.topicId, id)) {
        throw new Error(`topic ${plan.topicId} is no longer claimable (status changed since planning)`)
      }
      return id
    })()
    const result = await runJob(db, channel, jobId, stagesFor(plan.tier), {
      runsRoot: opts.runsRoot,
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
