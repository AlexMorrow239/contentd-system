import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Database } from 'better-sqlite3'
import { nanoid } from 'nanoid'
import pino from 'pino'
import type { ChannelConfig } from '../config/channel.js'
import { classify } from '../errors.js'
import { markTopicUsedByJob, storyPartForJob } from '../scout/topics.js'
import { finalVideoPath } from '../stages/assemble.js'
import { readQcResult } from '../stages/qc.js'
import { readScriptArtifact } from '../stages/script.js'
import { STAGE_ORDER } from './types.js'
import type { JobContext, StageDef, StageName } from './types.js'

const nowIso = (): string => new Date().toISOString()

export interface JobResult {
  jobId: string
  status: 'ready' | 'needs-review' | 'failed' | 'blocked'
  videoPath?: string
}

/** The one JobResult -> process exit code rule, shared by every CLI command that runs a job. */
export function exitCodeFor(result: JobResult): 0 | 1 {
  return result.status === 'failed' || result.status === 'blocked' ? 1 : 0
}

export function createJob(db: Database, channel: ChannelConfig, opts: { topic: string }): string {
  const jobId = nanoid()
  // The 'tier' column is a legacy NOT NULL CHECK ('volume','premium') left in
  // place for historical rows (see schema.sql) — no application code models a
  // tier concept anymore, so every new row just writes the literal 'volume'.
  const insertJob = db.prepare(
    "INSERT INTO jobs (id, channel, tier, topic, status) VALUES (?, ?, 'volume', ?, ?)",
  )
  const insertStage = db.prepare('INSERT INTO job_stages (job_id, stage, status) VALUES (?, ?, ?)')
  db.transaction(() => {
    insertJob.run(jobId, channel.name, opts.topic, 'queued')
    for (const stage of STAGE_ORDER) {
      insertStage.run(jobId, stage, 'pending')
    }
  })()
  return jobId
}

export async function runJob(
  db: Database,
  channel: ChannelConfig,
  jobId: string,
  stages: StageDef[],
  options: { runsRoot: string; heartbeat?: () => void },
): Promise<JobResult> {
  // Guard against path traversal: jobId is interpolated straight into runDir, so a
  // non-canonical id (e.g. '../outside') would escape runsRoot. nanoid ids only ever
  // use [A-Za-z0-9_-]; reject anything else before it touches the filesystem.
  if (!/^[A-Za-z0-9_-]+$/.test(jobId)) {
    throw new Error(`invalid job id: ${jobId}`)
  }

  const runDir = join(options.runsRoot, jobId)

  const jobRow = db.prepare('SELECT topic FROM jobs WHERE id = ?').get(jobId) as
    { topic: string } | undefined
  if (!jobRow) {
    throw new Error(`job not found: ${jobId}`)
  }

  const log = pino({ level: process.env.LOG_LEVEL ?? 'silent' }).child({ jobId })

  const ctx: JobContext = {
    jobId,
    db,
    channel,
    topic: jobRow.topic,
    story: storyPartForJob(db, jobId) ?? undefined,
    runDir,
    artifactPath(stage: StageName, file: string): string {
      const dir = join(runDir, stage)
      mkdirSync(dir, { recursive: true })
      return join(dir, file)
    },
    log,
  }

  db.prepare('UPDATE jobs SET status = ? WHERE id = ?').run('running', jobId)

  const stageStatus = db.prepare('SELECT status FROM job_stages WHERE job_id = ? AND stage = ?')
  const markStageRunning = db.prepare(
    'UPDATE job_stages SET status = ?, started_at = ? WHERE job_id = ? AND stage = ?',
  )
  // error = NULL: a stage succeeding on resume must not keep the error text
  // recorded by a previous failed attempt.
  const markStageDone = db.prepare(
    'UPDATE job_stages SET status = ?, finished_at = ?, error = NULL WHERE job_id = ? AND stage = ?',
  )
  const markStageFailed = db.prepare(
    'UPDATE job_stages SET status = ?, error = ?, finished_at = ? WHERE job_id = ? AND stage = ?',
  )

  for (const stage of stages) {
    const existing = stageStatus.get(jobId, stage.name) as { status: string } | undefined
    if (existing?.status === 'done') {
      continue
    }
    // Progress, not the clock, keeps the caller's loop lease alive: each stage
    // start says "still working". Best-effort — a failed extension only risks
    // the takeover that would have happened anyway, so it must not kill a
    // render that is already minutes deep.
    if (options.heartbeat !== undefined) {
      try {
        options.heartbeat()
      } catch (err) {
        log.warn(classify(err), 'lease heartbeat failed')
      }
    }
    markStageRunning.run('running', nowIso(), jobId, stage.name)
    try {
      await stage.run(ctx)
      markStageDone.run('done', nowIso(), jobId, stage.name)
    } catch (err) {
      const info = classify(err)
      markStageFailed.run('failed', info.message, nowIso(), jobId, stage.name)
      // A stage failure used to log nothing at all, which made a failed render
      // silent unless you queried job_stages. Inert by default — LOG_LEVEL is
      // 'silent' unless set. Note pino writes to STDOUT, so setting LOG_LEVEL
      // on a cron tick already interleaves with the one-JSON-line contract;
      // this adds one line to that pre-existing hazard, it does not create it.
      log.error({ ...info, stage: stage.name }, 'stage failed')
      // A budget breach is an enforcement outcome, not a crash: park the job
      // 'blocked' with the budget reason so operators can tell the two apart.
      const jobStatus = info.kind === 'budget' ? 'blocked' : 'failed'
      db.prepare('UPDATE jobs SET status = ?, finished_at = ? WHERE id = ?').run(
        jobStatus,
        nowIso(),
        jobId,
      )
      return { jobId, status: jobStatus }
    }
  }

  // Final gate: everything below reads artifacts and finalizes DB state. Any
  // error here (corrupt/missing qc.json or script.json, a failed transaction)
  // must not leave the job stuck 'running': mark it failed and report that.
  try {
    // Each artifact is read through its own stage's reader, so a stage that
    // renames its output file cannot leave this gate reading a path no module
    // writes. Their tolerance rules differ deliberately: qc.json is required
    // (its absence means the gate cannot decide a state at all), while
    // script.json is optional for jobs produced before that artifact existed.
    const qcResult = readQcResult(runDir)
    const state: 'ready' | 'needs-review' = qcResult.passed ? 'ready' : 'needs-review'

    const videoPath = finalVideoPath(runDir)
    const metadataJson = JSON.stringify(readScriptArtifact(runDir)?.platformMeta ?? {})

    // The whole verdict rides along into library.qc_json (re-serialized from
    // the same read that decided `state`): the dashboard names the failing
    // checks from it, and runs/ may not outlive the row.
    //
    // Idempotent: a resume that reaches this final window again (all stages already
    // 'done') upserts the same library row and re-marks the job done without a
    // PRIMARY KEY conflict. The upsert + job-done update run in one transaction so
    // the two writes commit together.
    const libraryUpsert = db.prepare(
      'INSERT INTO library (job_id, video_path, metadata_json, state, qc_json) VALUES (?, ?, ?, ?, ?) ' +
        'ON CONFLICT(job_id) DO UPDATE SET video_path=excluded.video_path, metadata_json=excluded.metadata_json, state=excluded.state, qc_json=excluded.qc_json',
    )
    const markJobDone = db.prepare('UPDATE jobs SET status = ?, finished_at = ? WHERE id = ?')
    db.transaction(() => {
      libraryUpsert.run(jobId, videoPath, metadataJson, state, JSON.stringify(qcResult))
      // "Library-landed consumes the claimed topic" belongs to the write that
      // makes it true, not to each caller's postlude: this is the only place
      // that knows first-hand the final gate ran, and inside the transaction
      // the two writes commit together — there is no window in which a topic
      // is left 'claimed' behind a job already in the library. A no-op for a
      // job holding no claimed topic (a hand-run `produce`).
      markTopicUsedByJob(db, jobId)
      markJobDone.run('done', nowIso(), jobId)
    })()

    return {
      jobId,
      status: state,
      videoPath: existsSync(videoPath) ? videoPath : undefined,
    }
  } catch (err) {
    log.error(classify(err), 'final gate failed')
    db.prepare('UPDATE jobs SET status = ?, finished_at = ? WHERE id = ?').run(
      'failed',
      nowIso(),
      jobId,
    )
    return { jobId, status: 'failed' }
  }
}
