import type { Database } from 'better-sqlite3'
import { tryLoadChannelsDir } from '../config/channel.js'
import { BrainrotError } from '../errors.js'
import { pipelineStages } from '../jobs/pipeline.js'
import { ResumeError, resumeJob } from '../jobs/resume.js'
import { createJob, runJob } from '../jobs/runner.js'
import type { JobResult } from '../jobs/runner.js'
import type { StageDef } from '../jobs/types.js'
import { claimTopic } from '../scout/topics.js'
import {
  acquireLease,
  extendLease,
  leaseHolder,
  PRODUCE_LEASE_TTL_MS,
  releaseLease,
} from './lease.js'
import { planTick } from './plan-tick.js'

export interface TickResult {
  action: 'resumed' | 'produced' | 'noop'
  reason?:
    | 'lease-held'
    | 'no-eligible-work'
    | 'backlog-full'
    | 'claim-conflict'
    | 'resume-refused'
    | 'config-error'
  jobId?: string
  topicId?: number
  status?: JobResult['status']
  error?: string
}

/**
 * The one spelling of "the channels directory would not load" for every
 * unattended surface — both loop ticks, the `scout.run` and `digest.run`
 * actions, the one-shot CLI commands. All of them must report a broken TOML
 * identically (a noop with a named cause, exit 0, never a throw); the shape
 * lived as a literal in each, cross-referenced by prose.
 *
 * Callers that print or wrap add that themselves — this owns the JSON shape
 * only.
 */
export function configErrorNoop(error: string): TickResult {
  return { action: 'noop', reason: 'config-error', error }
}

// The topic slipped away between planning and claiming. Its own class so the
// claim transaction's rollback throw stays distinguishable from a real crash.
// Module-private by design, so its `job`/`conflict` classification is
// currently untested — it can't be imported into arch.test.ts's
// classification lint without exporting it for no other reason.
class ClaimConflictError extends BrainrotError {
  constructor(message: string) {
    super(message, { domain: 'job', kind: 'conflict' })
    this.name = 'ClaimConflictError'
  }
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
    stagesFor?: () => StageDef[]
  },
): Promise<TickResult> {
  const stagesFor = opts.stagesFor ?? pipelineStages
  // Config load comes BEFORE the lease: a broken channel TOML (or a missing
  // channels dir) blocks the whole tick either way, and burning a lease slot on
  // it would only mean the next firing waits on a lease that was never going to
  // do work. Reported like every other blocked-tick outcome — one JSON line,
  // exit 0, a named cause — instead of escaping to the CLI's catch as exit 1
  // with no JSON line at all, every firing, for as long as the file stays bad.
  // The cause travels in `error` only. It used to be printed to stderr here as
  // well, which was free under cron (one process, one line) but became spam
  // under the daemon: this tick reruns every 30 seconds, and an unstructured
  // print bypasses runWorker's idle dedupe, so a single bad TOML wrote 2,880
  // stderr lines a day. The one-shot `brainrot produce-next` CLI prints it
  // instead (src/cli.ts), which is the surface that ever had a reader for it.
  const loaded = tryLoadChannelsDir(opts.channelsDir)
  if (loaded.error !== undefined) {
    return configErrorNoop(loaded.error)
  }
  const channels = loaded.channels
  // A held lease is the NORMAL case while a long render from the previous
  // cron firing is still running — benign no-op, exit 0 at the CLI. The
  // pid-tagged holder means an expiry takeover can never be released by the
  // evicted process (releaseLease matches on holder).
  //
  // KNOWN GAP: `actions-worker.ts`'s slow lane also calls this tick
  // in-process now, as a second caller sharing this same pid — until this
  // branch, `holder` uniquely identified one caller and lease.ts:43-44's
  // evicted-holder guarantee held exactly. It no longer does: a stalled
  // in-process caller's `finally`-release can now delete a live caller's
  // lease. Not fixed here (leaseHolder takes the suffix that would fix it,
  // but it has to be threaded through both ticks) — currently bounded because
  // topic claiming is transactional, so this collision cannot double-claim a
  // topic.
  const holder = leaseHolder()
  if (!acquireLease(db, 'produce', holder, PRODUCE_LEASE_TTL_MS)) {
    return { action: 'noop', reason: 'lease-held' }
  }
  try {
    // A render longer than the lease TTL would otherwise let the next cron
    // firing start a second tick on top of this one. extendLease matches on
    // holder, so a lease already taken over is never re-acquired here. BOTH
    // work paths get this same callback: a resumed render is exactly as long
    // as a fresh one, and it is the resume path that runs the jobs already
    // known to be slow.
    const heartbeat = (): void => {
      extendLease(db, 'produce', holder, PRODUCE_LEASE_TTL_MS)
    }
    // Repair sweep. The crash window it was written for is closed: runJob's
    // final gate now flips the topic to 'used' inside the same transaction as
    // the library row, so the two writes commit together. It is kept for the
    // rows produced BEFORE that change — a topic left 'claimed' but bound to a
    // job already in the library stays claimed forever, since resume refuses a
    // 'done' job and nothing else can recover it. Idempotent and cheap; run it
    // inside the lease before planning this tick.
    db.prepare(
      "UPDATE topics SET status = 'used' WHERE status = 'claimed' AND job_id IN (SELECT job_id FROM library)",
    ).run()
    const plan = planTick(db, channels)

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
          heartbeat,
        })
      } catch (err) {
        // A ResumeError is a refusal, not a crash — one JSON line, exit 0,
        // instead of a stack trace every cron firing. But the three kinds are
        // NOT the same outcome, and reporting them identically hid a
        // permanently stuck job behind a benign label:
        //   'conflict'  — an operator's `resume` (or `topics reject`) won the
        //                 job between planning and claiming it. Self-healing;
        //                 the next tick simply plans again.
        //   otherwise   — the job or its channel TOML is gone, or the job is
        //                 already done. No tick heals that, so it must not
        //                 wear the race's label. Carry the message out so the
        //                 operator sees WHICH job and WHICH file.
        if (err instanceof ResumeError) {
          return err.kind === 'conflict'
            ? { action: 'noop', reason: 'claim-conflict' }
            : { action: 'noop', reason: 'resume-refused', error: err.message }
        }
        throw err
      }
      return { action: 'resumed', jobId: plan.jobId, status: result.status }
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
        const id = createJob(db, channel, { topic: plan.topic })
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
    // Library-landed is the only used-flip, and it is runJob's final-gate
    // transaction that makes it: a failed/blocked job keeps its topic
    // 'claimed' and bound to the job — the resume path owns recovery, so the
    // topic is never re-claimed or lost.
    const result = await runJob(db, channel, jobId, stagesFor(), {
      runsRoot: opts.runsRoot,
      heartbeat,
    })
    return { action: 'produced', jobId, topicId: plan.topicId, status: result.status }
  } finally {
    releaseLease(db, 'produce', holder)
  }
}
