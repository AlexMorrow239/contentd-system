import { existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Database } from 'better-sqlite3'
import { nanoid } from 'nanoid'
import pino from 'pino'
import type { ChannelConfig } from '../config/channel.js'
import { classify } from '../errors.js'
import { markTopicUsedByJob, storyPartForJob } from '../scout/topics.js'
import { readQcResult } from '../stages/qc.js'
import { readScriptArtifact } from '../stages/script.js'
import { requireLease, type LeaseContext } from '../loop/lease.js'
import { assertAttempt, beginAttempt } from './execution.js'
import { makeBudgetWait } from './budget-wait.js'
import { STAGE_ORDER } from './types.js'
import type { JobContext, StageDef, StageName } from './types.js'
import { resolveTime, systemTime, type TimeSource } from '../time.js'

export interface JobResult {
  jobId: string
  status: 'ready' | 'needs-review' | 'failed' | 'blocked'
  videoPath?: string
}
export function exitCodeFor(result: JobResult): 0 | 1 {
  return result.status === 'failed' || result.status === 'blocked' ? 1 : 0
}

export function createJob(
  db: Database,
  channel: ChannelConfig,
  opts: { topic: string; time?: TimeSource },
): string {
  const id = nanoid()
  db.transaction(() => {
    db.prepare(
      "INSERT INTO jobs (id,channel,tier,topic,status,created_at) VALUES (?,?,'volume',?,'queued',?)",
    ).run(id, channel.name, opts.topic, (opts.time ?? systemTime).now().toISOString())
    const insert = db.prepare('INSERT INTO job_stages (job_id,stage,status) VALUES (?,?,?)')
    for (const stage of STAGE_ORDER) insert.run(id, stage, 'pending')
  })()
  return id
}

export async function runJob(
  db: Database,
  channel: ChannelConfig,
  jobId: string,
  stages: StageDef[],
  options: { runsRoot: string; lease?: LeaseContext; time?: TimeSource },
): Promise<JobResult> {
  if (!/^[A-Za-z0-9_-]+$/.test(jobId)) throw new Error(`invalid job id: ${jobId}`)
  const time = resolveTime(options.time, options.lease)
  const lease = options.lease ?? requireLease(db, 'produce', undefined, { time })
  try {
    lease.assertOwned()
    const completed = db
      .prepare(
        "SELECT l.state,l.video_path FROM jobs j JOIN library l ON l.job_id=j.id WHERE j.id=? AND j.status='done'",
      )
      .get(jobId) as { state: string; video_path: string } | undefined
    if (completed && (completed.state === 'ready' || completed.state === 'needs-review'))
      return {
        jobId,
        status: completed.state,
        videoPath: existsSync(completed.video_path) ? completed.video_path : undefined,
      }
    return await execute(db, channel, jobId, stages, options, lease)
  } finally {
    if (!options.lease) lease.release()
  }
}

async function execute(
  db: Database,
  channel: ChannelConfig,
  jobId: string,
  stages: StageDef[],
  options: { runsRoot: string },
  lease: LeaseContext,
): Promise<JobResult> {
  const time = lease.time
  const job = db
    .prepare('SELECT topic,recovery_count,recovery_stage,previous_attempt_id FROM jobs WHERE id=?')
    .get(jobId) as
    | {
        topic: string
        recovery_count: number
        recovery_stage: StageName | null
        previous_attempt_id: string | null
      }
    | undefined
  if (!job) throw new Error(`job not found: ${jobId}`)
  const attemptId = beginAttempt(db, jobId, lease)
  const root = join(options.runsRoot, jobId)
  const runDir = join(root, 'attempts', attemptId)
  const log = pino({ level: process.env.LOG_LEVEL ?? 'silent' }).child({ jobId, attemptId })
  const committed = new Map(
    (
      db
        .prepare("SELECT stage,artifact_dir FROM job_stages WHERE job_id=? AND status='done'")
        .all(jobId) as { stage: StageName; artifact_dir: string | null }[]
    ).map((r) => [r.stage, r.artifact_dir ?? join(root, r.stage)]),
  )
  const assertOwned = (): void => assertAttempt(db, jobId, attemptId, lease)
  const ctx: JobContext = {
    time,
    jobId,
    db,
    channel,
    topic: job.topic,
    story: storyPartForJob(db, jobId) ?? undefined,
    runDir,
    attemptId,
    signal: lease.signal,
    assertOwned,
    log,
    artifactPath(stage, file) {
      const dir = committed.get(stage) ?? join(runDir, stage)
      mkdirSync(dir, { recursive: true })
      return join(dir, file)
    },
  }
  const mutate = (work: (now: Date) => void): void => {
    db.transaction(() => {
      assertOwned()
      work(time.now())
    }).immediate()
  }
  const finish = (
    status: 'done' | 'failed' | 'blocked',
    now: Date,
    wait: string | null = null,
  ): void => {
    db.prepare('UPDATE execution_attempts SET status=?,finished_at=? WHERE id=?').run(
      status,
      now.toISOString(),
      attemptId,
    )
    db.prepare(
      'UPDATE jobs SET status=?,finished_at=?,active_attempt_id=NULL,budget_wait_json=?,retry_after=?,recovery_pending=0 WHERE id=?',
    ).run(
      status,
      now.toISOString(),
      wait,
      status === 'blocked' ? new Date(now.getTime() + 60_000).toISOString() : null,
      jobId,
    )
  }
  let warned = false
  for (const stage of stages) {
    if (committed.has(stage.name)) continue
    assertOwned()
    if (!warned && job.recovery_count > 0) {
      warned = true
      const action = db
        .prepare('SELECT id FROM operator_actions WHERE job_id=? ORDER BY id DESC LIMIT 1')
        .get(jobId) as { id: number } | undefined
      const possibleDuplicateCharge =
        job.recovery_stage === 'script' ||
        (job.recovery_stage === 'voice' && channel.voice.premium !== undefined)
      // Explicit stderr warning remains visible even when the ordinary logger is silent.
      console.warn(
        JSON.stringify({
          event: 'job-recovery',
          jobId,
          actionId: action?.id,
          stage: stage.name,
          previousAttemptId: job.previous_attempt_id,
          attemptId,
          recoveryCount: job.recovery_count,
          possibleDuplicateCharge,
          message: possibleDuplicateCharge
            ? 'Replaying interrupted paid stage: duplicate charges and incomplete cost accounting are possible'
            : 'Automatically resuming interrupted job',
        }),
      )
    }
    mutate((now) => {
      db.prepare(
        "UPDATE job_stages SET status='running',started_at=?,finished_at=NULL,error=NULL WHERE job_id=? AND stage=?",
      ).run(now.toISOString(), jobId, stage.name)
    })
    try {
      await stage.run(ctx)
      mutate((now) => {
        db.prepare(
          "UPDATE job_stages SET status='done',finished_at=?,error=NULL,artifact_dir=? WHERE job_id=? AND stage=?",
        ).run(now.toISOString(), join(runDir, stage.name), jobId, stage.name)
        db.prepare(
          'UPDATE jobs SET recovery_count=0,recovery_stage=NULL,previous_attempt_id=NULL,budget_wait_json=NULL,retry_after=NULL WHERE id=?',
        ).run(jobId)
      })
      committed.set(stage.name, join(runDir, stage.name))
    } catch (err) {
      // Lost owners may append known costs, but cannot alter authoritative state.
      assertOwned()
      const info = classify(err)
      const status = info.kind === 'budget' ? 'blocked' : 'failed'
      mutate((now) => {
        db.prepare(
          "UPDATE job_stages SET status='failed',error=?,finished_at=? WHERE job_id=? AND stage=?",
        ).run(info.message, now.toISOString(), jobId, stage.name)
        finish(
          status,
          now,
          status === 'blocked'
            ? JSON.stringify(makeBudgetWait(err, channel, stage.name, now))
            : null,
        )
      })
      log.error({ ...info, stage: stage.name }, 'stage failed')
      return { jobId, status }
    }
  }
  try {
    assertOwned()
    // Artifact readers retain their legacy stage-parent API; resolve through checkpoints.
    const stageParent = (name: StageName): string =>
      dirname(
        committed.get(name) ??
          (existsSync(join(runDir, name)) ? join(runDir, name) : join(root, name)),
      )
    const qc = readQcResult(stageParent('qc'))
    const state = qc.passed ? 'ready' : 'needs-review'
    const videoPath = join(committed.get('assemble') ?? join(root, 'assemble'), 'final.mp4')
    const metadata = JSON.stringify(readScriptArtifact(stageParent('script'))?.platformMeta ?? {})
    mutate((now) => {
      db.prepare(
        'INSERT INTO library (job_id,video_path,metadata_json,state,qc_json,created_at) VALUES (?,?,?,?,?,?) ON CONFLICT(job_id) DO UPDATE SET video_path=excluded.video_path,metadata_json=excluded.metadata_json,state=excluded.state,qc_json=excluded.qc_json',
      ).run(jobId, videoPath, metadata, state, JSON.stringify(qc), now.toISOString())
      markTopicUsedByJob(db, jobId)
      finish('done', now)
    })
    return { jobId, status: state, videoPath: existsSync(videoPath) ? videoPath : undefined }
  } catch (err) {
    assertOwned()
    mutate((now) => finish('failed', now))
    log.error(classify(err), 'final gate failed')
    return { jobId, status: 'failed' }
  }
}
