import type { Database } from 'better-sqlite3'
import type { ChannelConfig } from '../../../../daemon/src/config/channel.js'
import type { ActionRow } from '../../../../daemon/src/features/actions/types.js'
import type { LibraryState } from '../../../../daemon/src/features/library/library.js'
import { sqlPlaceholders } from '../../../../daemon/src/infra/db/sql.js'
import type { Platform } from '../../../../daemon/src/shared/contracts/platforms.js'
import { libraryBytes, summarizeQc, type LibraryBytes, type QcSummary } from './library.js'

export type JobChannels = readonly Pick<ChannelConfig, 'name' | 'platforms'>[]
export interface JobVideo {
  state: LibraryState
  createdAt: string
  qc: QcSummary
  bytes: LibraryBytes
}
export interface JobPost {
  platform: Platform
  url: string | null
  postedAt: string
}
export type JobAction = Pick<ActionRow, 'id' | 'kind' | 'status' | 'error' | 'notice'>
export interface JobContent {
  video: JobVideo | null
  posting: {
    kind: 'unposted' | 'partial' | 'full' | 'unconfigured'
    posted: number
    total: number
  } | null
  posts: JobPost[]
  action: JobAction | null
}

/** Three grouped reads for a page, including actions whose worker has not linked job_id yet. */
export function jobContents(
  db: Database,
  jobs: { id: string; channel: string }[],
  channels: JobChannels,
): Map<string, JobContent> {
  const result = new Map<string, JobContent>()
  if (!jobs.length) return result
  const ids = jobs.map((j) => j.id)
  const placeholders = sqlPlaceholders(ids.length)
  const videos = db
    .prepare(
      `SELECT job_id, state, created_at, qc_json, video_path FROM library
    WHERE job_id IN (${placeholders})`,
    )
    .all(...ids) as {
    job_id: string
    state: LibraryState
    created_at: string
    qc_json: string | null
    video_path: string
  }[]
  const posts = db
    .prepare(
      `SELECT job_id, platform, url, posted_at AS postedAt FROM posts
    WHERE job_id IN (${placeholders}) ORDER BY posted_at DESC, platform ASC`,
    )
    .all(...ids) as (JobPost & { job_id: string })[]
  // Scan the action log per link kind rather than per job, then keep one row
  // per job: the active action if any, otherwise the newest.
  const actions = db
    .prepare(
      `WITH args(id, kind, job_id, json) AS (
      SELECT id, kind, job_id, CASE WHEN json_valid(args) THEN args END FROM operator_actions
    ), targets(job_id, action_id) AS (
      SELECT job_id, id FROM args WHERE job_id IN (${placeholders})
      UNION
      SELECT json_extract(json, '$.jobId'), id FROM args
      WHERE json_extract(json, '$.jobId') IN (${placeholders})
      UNION
      SELECT t.value, a.id FROM args a, json_each(a.json, '$.jobIds') t
      WHERE a.kind IN ('library.approve', 'library.reject') AND t.value IN (${placeholders})
    )
    SELECT job_id, id, kind, status, error, notice FROM (
      SELECT t.job_id, a.id, a.kind, a.status, a.error, a.notice, ROW_NUMBER() OVER (
        PARTITION BY t.job_id ORDER BY (a.status IN ('pending', 'running')) DESC, a.id DESC
      ) AS n
      FROM targets t JOIN operator_actions a ON a.id = t.action_id
    ) WHERE n = 1`,
    )
    .all(...ids, ...ids, ...ids) as (JobAction & { job_id: string })[]
  const declared = new Map(channels.map((c) => [c.name, c.platforms]))
  const byJob = new Map(videos.map((v) => [v.job_id, v]))
  const postsByJob = new Map<string, JobPost[]>()
  for (const { job_id, ...post } of posts) {
    const group = postsByJob.get(job_id) ?? []
    group.push(post)
    postsByJob.set(job_id, group)
  }
  const actionsByJob = new Map(actions.map(({ job_id, ...action }) => [job_id, action]))
  for (const job of jobs) {
    const video = byJob.get(job.id)
    const jobPosts = postsByJob.get(job.id) ?? []
    const platforms = declared.get(job.channel) ?? []
    const posted = jobPosts.filter((p) => platforms.includes(p.platform)).length
    result.set(job.id, {
      video: video
        ? {
            state: video.state,
            createdAt: video.created_at,
            qc: summarizeQc(video.qc_json),
            bytes: libraryBytes(video, platforms.length > 0 && posted === platforms.length),
          }
        : null,
      posting: video
        ? {
            kind: !platforms.length
              ? 'unconfigured'
              : posted === platforms.length
                ? 'full'
                : posted
                  ? 'partial'
                  : 'unposted',
            posted,
            total: platforms.length,
          }
        : null,
      posts: jobPosts,
      action: actionsByJob.get(job.id) ?? null,
    })
  }
  return result
}
