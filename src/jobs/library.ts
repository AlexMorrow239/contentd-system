import type { Database } from 'better-sqlite3'
import { sqlPlaceholders, whereClause } from '../db/sql.js'
import { fullyPostedClause } from '../posts/posts.js'
import type { Platform } from '../posts/types.js'

export const LIBRARY_STATES = ['ready', 'needs-review', 'blocked'] as const

export type LibraryState = (typeof LIBRARY_STATES)[number]

export interface LibraryRow {
  jobId: string
  channel: string
  topic: string
  videoPath: string
  state: LibraryState
  createdAt: string
}

const LIBRARY_COLUMNS =
  'library.job_id AS job_id, jobs.channel AS channel, jobs.topic AS topic, ' +
  'library.video_path AS video_path, library.state AS state, library.created_at AS created_at'

interface DbLibraryRow {
  job_id: string
  channel: string
  topic: string
  video_path: string
  state: LibraryState
  created_at: string
}

function toLibraryRow(row: DbLibraryRow): LibraryRow {
  return {
    jobId: row.job_id,
    channel: row.channel,
    topic: row.topic,
    videoPath: row.video_path,
    state: row.state,
    createdAt: row.created_at,
  }
}

export function listLibrary(
  db: Database,
  filter?: { state?: LibraryState; channel?: string },
): LibraryRow[] {
  const { clause, params } = whereClause([
    ['library.state = ?', filter?.state],
    ['jobs.channel = ?', filter?.channel],
  ])
  const rows = db
    .prepare(
      `SELECT ${LIBRARY_COLUMNS} FROM library JOIN jobs ON library.job_id = jobs.id${clause} ` +
        'ORDER BY created_at DESC',
    )
    .all(...params) as DbLibraryRow[]
  return rows.map(toLibraryRow)
}

/** Promote only needs-review rows; unknown or already-decided ids are no-ops. */
export function approveLibrary(db: Database, jobIds: string[]): number {
  if (jobIds.length === 0) return 0
  const placeholders = sqlPlaceholders(jobIds.length)
  return db
    .prepare(
      `UPDATE library SET state = 'ready'
       WHERE job_id IN (${placeholders}) AND state = 'needs-review'`,
    )
    .run(...jobIds).changes
}

/** Retire ready or needs-review rows without deleting their local files. */
export function rejectLibrary(db: Database, jobIds: string[]): number {
  if (jobIds.length === 0) return 0
  const placeholders = sqlPlaceholders(jobIds.length)
  return db
    .prepare(
      `UPDATE library SET state = 'blocked' WHERE job_id IN (${placeholders}) AND state IN ('needs-review', 'ready')`,
    )
    .run(...jobIds).changes
}

/**
 * How many finished videos this channel is still holding — the number
 * plan-tick compares against backlogCap.
 *
 * A video is unconsumed until it is posted to every declared platform.
 * Needs-review videos count because they already consumed production capacity.
 */
export function pendingInventory(
  db: Database,
  opts: { channel: string; declared: readonly Platform[] },
): number {
  const unposted = fullyPostedClause(opts.declared, { alias: 'l', match: 'not-fully' })
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM library l JOIN jobs j ON j.id = l.job_id
       WHERE j.channel = ? AND l.state IN ('needs-review', 'ready')
         AND ${unposted.sql}`,
    )
    .get(opts.channel, ...unposted.params) as { n: number }
  return row.n
}
