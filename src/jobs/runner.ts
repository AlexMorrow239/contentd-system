import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Database } from 'better-sqlite3'
import { nanoid } from 'nanoid'
import pino from 'pino'
import type { ChannelConfig } from '../config/channel.js'
import { BudgetExceededError } from './costs.js'
import { STAGE_ORDER } from './types.js'
import type { JobContext, StageDef, StageName } from './types.js'

const nowIso = (): string => new Date().toISOString()

export interface JobResult {
  jobId: string
  status: 'ready' | 'needs-review' | 'failed' | 'blocked'
  videoPath?: string
}

export function createJob(
  db: Database,
  channel: ChannelConfig,
  opts: { topic: string },
  _options: { runsRoot?: string } = {},
): string {
  const jobId = nanoid()
  // The 'tier' column is a legacy NOT NULL CHECK ('volume','premium') left in
  // place for historical rows (see schema.sql) — no application code models a
  // tier concept anymore, so every new row just writes the literal 'volume'.
  const insertJob = db.prepare(
    "INSERT INTO jobs (id, channel, tier, topic, status) VALUES (?, ?, 'volume', ?, ?)",
  )
  const insertStage = db.prepare(
    'INSERT INTO job_stages (job_id, stage, status) VALUES (?, ?, ?)',
  )
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
  options: { runsRoot?: string; heartbeat?: () => void } = {},
): Promise<JobResult> {
  // Guard against path traversal: jobId is interpolated straight into runDir, so a
  // non-canonical id (e.g. '../outside') would escape runsRoot. nanoid ids only ever
  // use [A-Za-z0-9_-]; reject anything else before it touches the filesystem.
  if (!/^[A-Za-z0-9_-]+$/.test(jobId)) {
    throw new Error(`invalid job id: ${jobId}`)
  }

  const runsRoot = options.runsRoot ?? 'runs'
  const runDir = join(runsRoot, jobId)

  const jobRow = db
    .prepare('SELECT topic FROM jobs WHERE id = ?')
    .get(jobId) as { topic: string } | undefined
  if (!jobRow) {
    throw new Error(`job not found: ${jobId}`)
  }

  const log = pino({ level: process.env.LOG_LEVEL ?? 'silent' }).child({ jobId })

  const ctx: JobContext = {
    jobId,
    db,
    channel,
    topic: jobRow.topic,
    runDir,
    artifactPath(stage: StageName, file: string): string {
      const dir = join(runDir, stage)
      mkdirSync(dir, { recursive: true })
      return join(dir, file)
    },
    log,
  }

  db.prepare('UPDATE jobs SET status = ? WHERE id = ?').run('running', jobId)

  const stageStatus = db.prepare(
    'SELECT status FROM job_stages WHERE job_id = ? AND stage = ?',
  )
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
        log.warn({ err: err instanceof Error ? err.message : String(err) }, 'lease heartbeat failed')
      }
    }
    markStageRunning.run('running', nowIso(), jobId, stage.name)
    try {
      await stage.run(ctx)
      markStageDone.run('done', nowIso(), jobId, stage.name)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      markStageFailed.run('failed', message, nowIso(), jobId, stage.name)
      // A budget breach is an enforcement outcome, not a crash: park the job
      // 'blocked' with the budget reason so operators can tell the two apart.
      const jobStatus = err instanceof BudgetExceededError ? 'blocked' : 'failed'
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
    const qc = JSON.parse(readFileSync(join(runDir, 'qc', 'qc.json'), 'utf8')) as {
      passed: boolean
    }
    const state: 'ready' | 'needs-review' = qc.passed ? 'ready' : 'needs-review'

    const videoPath = join(runDir, 'assemble', 'final.mp4')
    const scriptPath = join(runDir, 'script', 'script.json')
    let metadataJson = '{}'
    if (existsSync(scriptPath)) {
      const script = JSON.parse(readFileSync(scriptPath, 'utf8')) as { platformMeta?: unknown }
      metadataJson = JSON.stringify(script.platformMeta ?? {})
    }

    // Idempotent: a resume that reaches this final window again (all stages already
    // 'done') upserts the same library row and re-marks the job done without a
    // PRIMARY KEY conflict. The upsert + job-done update run in one transaction so
    // the two writes commit together.
    const libraryUpsert = db.prepare(
      'INSERT INTO library (job_id, video_path, metadata_json, state) VALUES (?, ?, ?, ?) ' +
        'ON CONFLICT(job_id) DO UPDATE SET video_path=excluded.video_path, metadata_json=excluded.metadata_json, state=excluded.state',
    )
    const markJobDone = db.prepare('UPDATE jobs SET status = ?, finished_at = ? WHERE id = ?')
    db.transaction(() => {
      libraryUpsert.run(jobId, videoPath, metadataJson, state)
      markJobDone.run('done', nowIso(), jobId)
    })()

    return {
      jobId,
      status: state,
      videoPath: existsSync(videoPath) ? videoPath : undefined,
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    log.error({ err: message }, 'final gate failed')
    db.prepare('UPDATE jobs SET status = ?, finished_at = ? WHERE id = ?').run(
      'failed',
      nowIso(),
      jobId,
    )
    return { jobId, status: 'failed' }
  }
}
