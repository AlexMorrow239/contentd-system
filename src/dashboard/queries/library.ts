import type { Database } from 'better-sqlite3'
import type { LibraryState } from '../../jobs/library.js'

export type QcSummary =
  | { kind: 'ok' }
  | { kind: 'issues'; issues: string[] }
  | { kind: 'unparseable' }
  | { kind: 'absent' }

export interface LibraryEntry {
  jobId: string
  channel: string
  topic: string
  state: LibraryState
  videoPath: string
  createdAt: string
  qc: QcSummary
}

/**
 * metadata_json is the script stage's per-platform meta map; the qc stage adds
 * a `qc` block to it. Every failure mode of that JSON is contained to the one
 * row: a corrupt blob renders as 'unparseable' beside its neighbours rather
 * than taking the page down.
 */
export function summarizeQc(metadataJson: string): QcSummary {
  let parsed: unknown
  try {
    parsed = JSON.parse(metadataJson)
  } catch {
    return { kind: 'unparseable' }
  }
  if (typeof parsed !== 'object' || parsed === null) return { kind: 'unparseable' }
  const qc = (parsed as { qc?: unknown }).qc
  if (qc === undefined) return { kind: 'absent' }
  if (typeof qc !== 'object' || qc === null) return { kind: 'unparseable' }
  const issues = (qc as { issues?: unknown }).issues
  if (!Array.isArray(issues)) return { kind: 'unparseable' }
  const strings = issues.map((issue) => String(issue))
  return strings.length === 0 ? { kind: 'ok' } : { kind: 'issues', issues: strings }
}

interface DbLibraryEntry {
  job_id: string
  channel: string
  topic: string
  state: LibraryState
  video_path: string
  metadata_json: string
  created_at: string
}

function libraryWhereClause(filter?: { state?: LibraryState; channel?: string }): {
  clause: string
  params: string[]
} {
  const where: string[] = []
  const params: string[] = []
  if (filter?.state !== undefined) {
    where.push('library.state = ?')
    params.push(filter.state)
  }
  if (filter?.channel !== undefined) {
    where.push('jobs.channel = ?')
    params.push(filter.channel)
  }
  return { clause: where.length > 0 ? ` WHERE ${where.join(' AND ')}` : '', params }
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
        'library.metadata_json AS metadata_json, library.created_at AS created_at ' +
        `FROM library JOIN jobs ON library.job_id = jobs.id${clause} ` +
        'ORDER BY library.created_at DESC, library.job_id DESC LIMIT ?',
    )
    .all(...params, limit) as DbLibraryEntry[]

  return rows.map((row) => ({
    jobId: row.job_id,
    channel: row.channel,
    topic: row.topic,
    state: row.state,
    videoPath: row.video_path,
    createdAt: row.created_at,
    qc: summarizeQc(row.metadata_json),
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
