import { existsSync } from 'node:fs'
import type { Database } from 'better-sqlite3'
import type { LibraryState } from '../../jobs/library.js'

export type QcSummary =
  | { kind: 'ok' }
  | { kind: 'issues'; issues: string[] }
  | { kind: 'unparseable' }
  | { kind: 'absent' }

/**
 * Where this video's bytes are. 'local' — the runs/ file is still on disk and
 * the dashboard can stream it. 'archived' — only the bucket has it; the
 * dashboard holds no bucket credentials by design, so it can name the state
 * but not play the video. 'reclaimed' — the object was deliberately deleted
 * after every declared platform settled, and the live post is all that is
 * left. 'unstored' — there is no local file AND no library_objects row: the
 * video was never uploaded to object storage at all, distinct from
 * 'archived' (uploaded, just not present locally). This is exactly the set
 * jobs/library.ts's unstoredLibraryJobs selects and digest.ts reports as the
 * `library backfill-store` backlog. Drawn from the database plus existsSync,
 * never from the bucket.
 */
export type LibraryBytes = 'local' | 'archived' | 'reclaimed' | 'unstored'

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
  object_key: string | null
  reclaimed_at: string | null
}

// Precedence: a reclaimed object is reclaimed even if a stale runs/ file
// happens to survive, because the durable copy is the one that is gone. Only
// once neither reclaimed-nor-local applies does the presence of a
// library_objects row distinguish 'archived' (uploaded) from 'unstored'
// (never uploaded).
export function libraryBytes(row: {
  video_path: string
  object_key: string | null
  reclaimed_at: string | null
}): LibraryBytes {
  if (row.reclaimed_at !== null) return 'reclaimed'
  if (existsSync(row.video_path)) return 'local'
  return row.object_key !== null ? 'archived' : 'unstored'
}

/**
 * Live post urls per job, in ONE grouped read rather than a query per row.
 * Only 'done' rows with a url qualify — a failed attempt has nothing to link
 * to, and a done row without one predates url capture.
 */
export function libraryLinks(db: Database, jobIds: string[]): Map<string, LibraryLink[]> {
  const byJob = new Map<string, LibraryLink[]>()
  if (jobIds.length === 0) return byJob
  const placeholders = jobIds.map(() => '?').join(', ')
  const rows = db
    .prepare(
      `SELECT job_id, platform, url FROM publishes
       WHERE job_id IN (${placeholders}) AND status = 'done' AND url IS NOT NULL
       ORDER BY job_id, platform`,
    )
    .all(...jobIds) as { job_id: string; platform: string; url: string }[]
  for (const row of rows) {
    const links = byJob.get(row.job_id) ?? []
    links.push({ platform: row.platform, url: row.url })
    byJob.set(row.job_id, links)
  }
  return byJob
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
        'library.metadata_json AS metadata_json, library.created_at AS created_at, ' +
        'library_objects.object_key AS object_key, library_objects.reclaimed_at AS reclaimed_at ' +
        'FROM library JOIN jobs ON library.job_id = jobs.id ' +
        `LEFT JOIN library_objects ON library_objects.job_id = library.job_id${clause} ` +
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
    qc: summarizeQc(row.metadata_json),
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
