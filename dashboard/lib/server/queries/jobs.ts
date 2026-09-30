import type { Database } from 'better-sqlite3'
import { parseBudgetWait, type BudgetWait } from '../../../../daemon/src/jobs/budget-wait.js'
import { sqlPlaceholders, whereClause } from '../../../../daemon/src/db/sql.js'
import { fullyPostedClause } from '../../../../daemon/src/posts/posts.js'
import { hasActiveAction } from './actions.js'
import { jobContents, type JobContent, type JobChannels, type JobPost } from './job-content.js'
import type { JOB_STATUSES, JobFilters } from '../../shared/job-filters.js'

export type JobStatus = (typeof JOB_STATUSES)[number]
export type StageStatus = 'pending' | 'running' | 'done' | 'failed'

/**
 * Stage order for the drill-in timeline. Hardcoded rather than imported from
 * jobs/pipeline.ts because that module transitively imports remotion
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
] as const

export interface JobListRow extends Omit<JobContent, 'posts'> {
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

// A resume waits in the action queue without changing the persisted job until
// the worker owns it. Reuse the job's queued status in every dashboard view.
const JOB_STATUS = `CASE WHEN jobs.status IN ('failed', 'blocked') AND EXISTS (
  SELECT 1 FROM operator_actions
  WHERE kind = 'jobs.resume' AND status IN ('pending', 'running')
    AND json_extract(CASE WHEN json_valid(args) THEN args END, '$.jobId') = jobs.id
) THEN 'queued' ELSE jobs.status END`

// COALESCE, not a bare SUM: a job with no costs rows must report 0, and the
// LEFT JOIN would otherwise surface null through the typed interface.
const JOB_COLUMNS =
  'jobs.id AS id, jobs.channel AS channel, jobs.tier AS tier, jobs.topic AS topic, ' +
  `${JOB_STATUS} AS status, jobs.created_at AS created_at, jobs.finished_at AS finished_at, ` +
  'COALESCE((SELECT SUM(usd_micros) FROM costs WHERE costs.job_id = jobs.id), 0) AS cost_usd_micros'

function toJobRow(row: DbJobRow, content: JobContent): JobListRow {
  return {
    id: row.id,
    channel: row.channel,
    tier: row.tier,
    topic: row.topic,
    status: row.status,
    createdAt: row.created_at,
    finishedAt: row.finished_at,
    costUsdMicros: row.cost_usd_micros,
    video: content.video,
    posting: content.posting,
    action: content.action,
  }
}

const JOB_FROM = ' FROM jobs LEFT JOIN library l ON l.job_id = jobs.id'

function jobsWhereClause(
  filter: JobFilters = {},
  channels: JobChannels = [],
): {
  clause: string
  params: unknown[]
} {
  const base = whereClause([
    ['jobs.deleted_at IS ?', null],
    ['jobs.channel = ?', filter.channel],
    [`${JOB_STATUS} = ?`, filter.status],
    ["instr(lower(jobs.topic || ' ' || jobs.id), lower(?)) > 0", filter.q],
  ])
  if (filter.review === 'none') base.clause += ' AND l.job_id IS NULL'
  else if (filter.review) {
    base.clause += ' AND l.state = ?'
    base.params.push(filter.review)
  }
  if (filter.posting === 'has-posts') {
    base.clause += ' AND EXISTS (SELECT 1 FROM posts WHERE posts.job_id = jobs.id)'
  } else if (filter.posting) {
    const choices = channels
      .filter((c) => c.platforms.length)
      .map((channel) => {
        const fully = fullyPostedClause(channel.platforms, { alias: 'l', match: 'fully' })
        const any = `EXISTS (SELECT 1 FROM posts p WHERE p.job_id = jobs.id AND p.platform IN (${sqlPlaceholders(channel.platforms.length)}))`
        base.params.push(channel.name)
        let predicate: string
        if (filter.posting === 'full') {
          predicate = fully.sql
          base.params.push(...fully.params)
        } else if (filter.posting === 'partial') {
          predicate = `${any} AND NOT (${fully.sql})`
          base.params.push(...channel.platforms, ...fully.params)
        } else {
          predicate = `NOT (${any})`
          base.params.push(...channel.platforms)
        }
        return `(jobs.channel = ? AND ${predicate})`
      })
    base.clause += ` AND l.job_id IS NOT NULL AND (${choices.join(' OR ') || '0'})`
  }
  return base
}

export function listJobs(
  db: Database,
  filter?: JobFilters & { limit?: number; offset?: number },
  channels: JobChannels = [],
): JobListRow[] {
  const { clause, params } = jobsWhereClause(filter, channels)
  const rows = db
    .prepare(
      `SELECT ${JOB_COLUMNS}${JOB_FROM}${clause} ORDER BY jobs.created_at DESC, jobs.id DESC LIMIT ? OFFSET ?`,
    )
    .all(...params, filter?.limit ?? 200, filter?.offset ?? 0) as DbJobRow[]
  const content = jobContents(db, rows, channels)
  return rows.map((row) => toJobRow(row, content.get(row.id)!))
}

export function countJobs(db: Database, filter?: JobFilters, channels: JobChannels = []): number {
  const { clause, params } = jobsWhereClause(filter, channels)
  const row = db.prepare(`SELECT COUNT(*) AS count${JOB_FROM}${clause}`).get(...params) as {
    count: number
  }
  return row.count
}

/** Includes work hidden by the current filter, so a failed-only view can update after resume. */
export function jobsRefreshSeconds(db: Database): number | undefined {
  const activeJob = db
    .prepare(
      "SELECT 1 FROM jobs WHERE deleted_at IS NULL AND status IN ('running', 'queued') LIMIT 1",
    )
    .get()
  return activeJob || hasActiveAction(db) ? 3 : undefined
}

export function jobChannels(db: Database): string[] {
  const rows = db
    .prepare('SELECT DISTINCT channel FROM jobs WHERE deleted_at IS NULL ORDER BY channel ASC')
    .all() as {
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
  budgetWait: BudgetWait | null
  retryAfter: string | null
  stages: StageRow[]
  costs: JobCostRow[]
  posts: JobPost[]
}

export function getJobDetail(
  db: Database,
  jobId: string,
  channels: JobChannels = [],
): JobDetail | null {
  const row = db
    .prepare(
      `SELECT ${JOB_COLUMNS}, jobs.budget_wait_json, jobs.retry_after FROM jobs WHERE jobs.id = ? AND jobs.deleted_at IS NULL`,
    )
    .get(jobId) as
    (DbJobRow & { budget_wait_json: string | null; retry_after: string | null }) | undefined
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

  const content = jobContents(db, [row], channels).get(jobId)!
  return {
    job: toJobRow(row, content),
    posts: content.posts,
    budgetWait: parseBudgetWait(row.budget_wait_json),
    retryAfter: row.retry_after,
    stages,
    costs,
  }
}
