import { existsSync } from 'node:fs'
import type { Database } from 'better-sqlite3'
import { whereClause } from '../../../../daemon/src/db/sql.js'
import type { LibraryState } from '../../../../daemon/src/jobs/library.js'
import { postedPlatforms } from '../../../../daemon/src/posts/posts.js'

export type QcSummary =
  | { kind: 'ok' }
  | { kind: 'issues'; issues: string[] }
  | { kind: 'unparseable' }
  | { kind: 'absent' }

export type LibraryBytes = 'local' | 'missing'

export interface LibraryLink {
  platform: string
  url: string
}

export interface LibraryEntry {
  jobId: string
  channel: string
  topic: string
  state: LibraryState
  videoPath: string
  createdAt: string
  qc: QcSummary
  bytes: LibraryBytes
  /** One per platform that published, ordered by platform for stability. */
  links: LibraryLink[]
}

/**
 * qc_json is runs/<jobId>/qc/qc.json (stages/qc.ts's QcResult), persisted
 * whole by the runner's final gate. NULL — a row finalized before the
 * column existed — is 'absent'. Every failure mode of the blob is contained
 * to the one row: a corrupt verdict renders as 'unparseable' beside its
 * neighbours rather than taking the page down.
 */
export function summarizeQc(qcJson: string | null): QcSummary {
  if (qcJson === null) return { kind: 'absent' }
  let parsed: unknown
  try {
    parsed = JSON.parse(qcJson)
  } catch {
    return { kind: 'unparseable' }
  }
  if (typeof parsed !== 'object' || parsed === null) return { kind: 'unparseable' }
  const checks = (parsed as { checks?: unknown }).checks
  if (!Array.isArray(checks)) return { kind: 'unparseable' }
  const issues: string[] = []
  for (const check of checks) {
    if (typeof check !== 'object' || check === null) return { kind: 'unparseable' }
    const { name, passed, detail } = check as { name?: unknown; passed?: unknown; detail?: unknown }
    if (typeof name !== 'string' || typeof passed !== 'boolean' || typeof detail !== 'string') {
      return { kind: 'unparseable' }
    }
    if (!passed) issues.push(`${name}: ${detail}`)
  }
  return issues.length === 0 ? { kind: 'ok' } : { kind: 'issues', issues }
}

interface DbLibraryEntry {
  job_id: string
  channel: string
  topic: string
  state: LibraryState
  video_path: string
  qc_json: string | null
  created_at: string
}

export function libraryBytes(row: { video_path: string }): LibraryBytes {
  return existsSync(row.video_path) ? 'local' : 'missing'
}

/**
 * Post urls per job, derived from the DAO's own grouped read (postedPlatforms)
 * rather than a second query over the same rows — the two answered "which
 * platforms carry this job" from independently written SQL, and a job present
 * in one but not the other is a link column that disagrees with the posting
 * queue beside it.
 *
 * A post with no url is a real post the operator did not paste a link for, so
 * it is dropped here (there is nothing to link to) while still counting
 * everywhere else — and a job whose every post lacks a url is ABSENT from the
 * map, not present with an empty list. Platform order is stable so the column
 * does not reshuffle between renders.
 */
export function libraryLinks(db: Database, jobIds: string[]): Map<string, LibraryLink[]> {
  const byJob = new Map<string, LibraryLink[]>()
  for (const [jobId, byPlatform] of postedPlatforms(db, jobIds)) {
    const links: LibraryLink[] = []
    for (const [platform, url] of byPlatform) {
      if (url !== null) links.push({ platform, url })
    }
    if (links.length === 0) continue
    links.sort((a, b) => (a.platform < b.platform ? -1 : a.platform > b.platform ? 1 : 0))
    byJob.set(jobId, links)
  }
  return byJob
}

function libraryWhereClause(filter?: { state?: LibraryState; channel?: string }): {
  clause: string
  params: unknown[]
} {
  return whereClause([
    ['library.state = ?', filter?.state],
    ['jobs.channel = ?', filter?.channel],
  ])
}

// limit defaults to 200, matching listJobs's shape — nothing prunes the
// library table, and an unbounded SELECT would render every row ever finished.
export function listLibraryEntries(
  db: Database,
  filter?: { state?: LibraryState; channel?: string; limit?: number },
): LibraryEntry[] {
  const { clause, params } = libraryWhereClause(filter)
  const limit = filter?.limit ?? 200
  const rows = db
    .prepare(
      'SELECT library.job_id AS job_id, jobs.channel AS channel, jobs.topic AS topic, ' +
        'library.state AS state, library.video_path AS video_path, ' +
        'library.qc_json AS qc_json, library.created_at AS created_at ' +
        'FROM library JOIN jobs ON library.job_id = jobs.id ' +
        `${clause} ` +
        'ORDER BY library.created_at DESC, library.job_id DESC LIMIT ?',
    )
    .all(...params, limit) as DbLibraryEntry[]

  const links = libraryLinks(
    db,
    rows.map((r) => r.job_id),
  )

  return rows.map((row) => ({
    jobId: row.job_id,
    channel: row.channel,
    topic: row.topic,
    state: row.state,
    videoPath: row.video_path,
    createdAt: row.created_at,
    qc: summarizeQc(row.qc_json),
    bytes: libraryBytes(row),
    links: links.get(row.job_id) ?? [],
  }))
}

// Unbounded by the same limit listLibraryEntries applies, so the view can
// tell the operator "showing 200 of 1,432" rather than truncating silently.
export function countLibraryEntries(
  db: Database,
  filter?: { state?: LibraryState; channel?: string },
): number {
  const { clause, params } = libraryWhereClause(filter)
  const row = db
    .prepare(`SELECT COUNT(*) AS count FROM library JOIN jobs ON library.job_id = jobs.id${clause}`)
    .get(...params) as { count: number }
  return row.count
}

export function libraryChannels(db: Database): string[] {
  const rows = db
    .prepare(
      'SELECT DISTINCT jobs.channel AS channel FROM library ' +
        'JOIN jobs ON library.job_id = jobs.id ORDER BY channel ASC',
    )
    .all() as { channel: string }[]
  return rows.map((r) => r.channel)
}

export function findLibraryVideoPath(db: Database, jobId: string): string | null {
  const row = db.prepare('SELECT video_path FROM library WHERE job_id = ?').get(jobId) as
    { video_path: string } | undefined
  return row?.video_path ?? null
}
