import { resolve, sep } from 'node:path'

/**
 * Parse a single-range HTTP Range header. Returns null for absent, malformed,
 * multi-range or unsatisfiable headers — the caller then serves the whole
 * file with 200, which is a valid response to any Range request.
 */
export function parseRange(
  header: string | undefined,
  size: number,
): { start: number; end: number } | null {
  if (header === undefined) return null
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (match === null) return null
  const rawStart = match[1] as string
  const rawEnd = match[2] as string
  if (rawStart === '' && rawEnd === '') return null

  if (rawStart === '') {
    const suffix = Number(rawEnd)
    if (suffix <= 0) return null
    return { start: Math.max(0, size - suffix), end: size - 1 }
  }

  const start = Number(rawStart)
  if (start >= size) return null
  const end = rawEnd === '' ? size - 1 : Math.min(Number(rawEnd), size - 1)
  if (end < start) return null
  return { start, end }
}

/**
 * Containment check for a database-sourced video path. Relative paths resolve
 * against the process cwd, which is how the pipeline writes them:
 * runner.ts's artifactPath joins a relative runsRoot ('runs'), so library rows
 * hold 'runs/<jobId>/assemble/final.mp4'.
 *
 * Returns the absolute path, or null when it escapes runsRoot.
 */
export function resolveVideoPath(runsRoot: string, videoPath: string): string | null {
  const root = resolve(runsRoot)
  const candidate = resolve(videoPath)
  // The trailing separator is what stops '/app/runs-evil' from passing as
  // being inside '/app/runs'. The root itself is not a video, so it fails too.
  if (!candidate.startsWith(root + sep)) return null
  return candidate
}
