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
  // A zero-byte file has no satisfiable range at all — every possible start/end
  // pair is out of bounds. Without this guard, 'bytes=-200' on size 0 falls
  // through to { start: 0, end: -1 }, and the route would emit a malformed
  // 206 with content-range: bytes 0--1/0.
  if (size === 0) return null
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (match === null) return null
  const rawStart = match[1]
  const rawEnd = match[2]
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
 * Containment check for a database-sourced video path. runsRoot is now an
 * runtime root path (e.g. '/app/state/runs' in the container — see
 * src/config/paths.ts), and
 * runner.ts's artifactPath joins jobId/stage/file onto it, so library rows
 * written under this branch hold absolute paths like
 * '/app/state/runs/<jobId>/assemble/final.mp4'. A handful of rows written
 * before this branch still hold the old relative 'runs/<jobId>/...' shape;
 * resolve() below anchors those against the process cwd, same as any other
 * relative path.
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
