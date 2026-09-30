import { existsSync } from 'node:fs'
import type { Database } from 'better-sqlite3'

export type QcSummary =
  | { kind: 'ok' }
  | { kind: 'issues'; issues: string[] }
  | { kind: 'unparseable' }
  | { kind: 'absent' }

export type LibraryBytes = 'local' | 'missing'

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

export function libraryBytes(row: { video_path: string }): LibraryBytes {
  return existsSync(row.video_path) ? 'local' : 'missing'
}

export function findLibraryVideoPath(db: Database, jobId: string): string | null {
  const row = db.prepare('SELECT video_path FROM library WHERE job_id = ?').get(jobId) as
    { video_path: string } | undefined
  return row?.video_path ?? null
}
