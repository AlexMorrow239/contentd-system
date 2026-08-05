import type { Database } from 'better-sqlite3'
import { whereClause } from '../../db/sql.js'
import { libraryBytes, libraryLinks } from './library.js'

// A tuple, not a bare union: the filter dropdowns need the values at runtime,
// and a hand-maintained second copy beside the type is what they used to be.
export const JOB_STATUSES = ['queued', 'running', 'failed', 'done', 'blocked'] as const

export type JobStatus = (typeof JOB_STATUSES)[number]
export type StageStatus = 'pending' | 'running' | 'done' | 'failed'

/**
 * Stage order for the drill-in timeline. Hardcoded rather than imported from
 * jobs/pipeline.ts because that module transitively imports remotion, kokoro
 * and the ffmpeg wrappers — a read-only viewer must not pull the renderer
 * into memory. queries/jobs.test.ts asserts this equals
 * pipelineStages().map(s => s.name), so it cannot silently drift.
 */
export const DASHBOARD_STAGE_ORDER = [
  'script',
  'voice',
  'captions',
  'visuals',
  'assemble',
  'qc',
  'store',
] as const

export interface JobListRow {
  id: string
  channel: string
  tier: 'volume' | 'premium'
  topic: string
  status: JobStatus
  createdAt: string
  finishedAt: string | null
  costUsdMicros: number
}

interface DbJobRow {
  id: string
  channel: string
  tier: 'volume' | 'premium'
  topic: string
  status: JobStatus
  created_at: string
  finished_at: string | null
  cost_usd_micros: number
}

// COALESCE, not a bare SUM: a job with no costs rows must report 0, and the
// LEFT JOIN would otherwise surface null through the typed interface.
const JOB_COLUMNS =
  'jobs.id AS id, jobs.channel AS channel, jobs.tier AS tier, jobs.topic AS topic, ' +
  'jobs.status AS status, jobs.created_at AS created_at, jobs.finished_at AS finished_at, ' +
  'COALESCE((SELECT SUM(usd_micros) FROM costs WHERE costs.job_id = jobs.id), 0) AS cost_usd_micros'

function toJobRow(row: DbJobRow): JobListRow {
  return {
    id: row.id,
    channel: row.channel,
    tier: row.tier,
    topic: row.topic,
    status: row.status,
    createdAt: row.created_at,
    finishedAt: row.finished_at,
    costUsdMicros: row.cost_usd_micros,
  }
}

function jobsWhereClause(filter?: { channel?: string; status?: JobStatus }): {
  clause: string
  params: unknown[]
} {
  return whereClause([
    ['jobs.channel = ?', filter?.channel],
    ['jobs.status = ?', filter?.status],
  ])
}

export function listJobs(
  db: Database,
  filter?: { channel?: string; status?: JobStatus; limit?: number },
): JobListRow[] {
  const { clause, params } = jobsWhereClause(filter)
  const limit = filter?.limit ?? 200
  const rows = db
    .prepare(
      `SELECT ${JOB_COLUMNS} FROM jobs${clause} ORDER BY jobs.created_at DESC, jobs.id DESC LIMIT ?`,
    )
    .all(...params, limit) as DbJobRow[]
  return rows.map(toJobRow)
}

// Unbounded by listJobs's limit, so the view can tell the operator
// "showing 200 of 1,432" rather than truncating silently.
export function countJobs(db: Database, filter?: { channel?: string; status?: JobStatus }): number {
  const { clause, params } = jobsWhereClause(filter)
  const row = db.prepare(`SELECT COUNT(*) AS count FROM jobs${clause}`).get(...params) as {
    count: number
  }
  return row.count
}

export function jobChannels(db: Database): string[] {
  const rows = db.prepare('SELECT DISTINCT channel FROM jobs ORDER BY channel ASC').all() as {
    channel: string
  }[]
  return rows.map((r) => r.channel)
}

export interface StageRow {
  stage: string
  status: StageStatus
  error: string | null
  startedAt: string | null
  finishedAt: string | null
}

export interface JobCostRow {
  provider: string
  operation: string
  usdMicros: number
  createdAt: string
}

export interface JobDetail {
  job: JobListRow
  stages: StageRow[]
  costs: JobCostRow[]
  libraryState: string | null
  videoPath: string | null
  /**
   * Where this job's video bytes are — same four states the library page
   * draws, from the database plus existsSync. The dashboard holds no bucket
   * credentials (design spec decision 9), so this is never fetched or
   * presigned. Null when the job has no library row at all.
   */
  bytes: 'local' | 'archived' | 'reclaimed' | 'unstored' | null
  /** Live post urls, one per platform that published. */
  links: { platform: string; url: string }[]
}

export function getJobDetail(db: Database, jobId: string): JobDetail | null {
  const row = db.prepare(`SELECT ${JOB_COLUMNS} FROM jobs WHERE jobs.id = ?`).get(jobId) as
    DbJobRow | undefined
  if (row === undefined) return null

  const stageRows = db
    .prepare(
      'SELECT stage, status, error, started_at, finished_at FROM job_stages WHERE job_id = ?',
    )
    .all(jobId) as {
    stage: string
    status: StageStatus
    error: string | null
    started_at: string | null
    finished_at: string | null
  }[]
  const byStage = new Map(stageRows.map((s) => [s.stage, s]))

  // Render the FULL pipeline every time, synthesizing 'pending' for stages
  // with no row yet. A timeline that only shows rows that exist hides exactly
  // the information you came for: how far the job got before it stopped.
  const stages: StageRow[] = DASHBOARD_STAGE_ORDER.map((stage) => {
    const found = byStage.get(stage)
    return {
      stage,
      status: found?.status ?? 'pending',
      error: found?.error ?? null,
      startedAt: found?.started_at ?? null,
      finishedAt: found?.finished_at ?? null,
    }
  })

  const costs = (
    db
      .prepare(
        'SELECT provider, operation, usd_micros, created_at FROM costs WHERE job_id = ? ' +
          'ORDER BY created_at DESC, id DESC',
      )
      .all(jobId) as {
      provider: string
      operation: string
      usd_micros: number
      created_at: string
    }[]
  ).map((c) => ({
    provider: c.provider,
    operation: c.operation,
    usdMicros: c.usd_micros,
    createdAt: c.created_at,
  }))

  const libraryRow = db
    .prepare(
      `SELECT l.state AS state, l.video_path AS video_path, lo.object_key AS object_key,
              lo.reclaimed_at AS reclaimed_at
       FROM library l LEFT JOIN library_objects lo ON lo.job_id = l.job_id
       WHERE l.job_id = ?`,
    )
    .get(jobId) as
    | { state: string; video_path: string; object_key: string | null; reclaimed_at: string | null }
    | undefined

  // Same precedence as the library page: libraryBytes owns it, this just calls it.
  const bytes: JobDetail['bytes'] = libraryRow === undefined ? null : libraryBytes(libraryRow)

  const links = libraryLinks(db, [jobId]).get(jobId) ?? []

  return {
    job: toJobRow(row),
    stages,
    costs,
    libraryState: libraryRow?.state ?? null,
    videoPath: libraryRow?.video_path ?? null,
    bytes,
    links,
  }
}
