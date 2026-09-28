import { createReadStream, statSync } from 'node:fs'
import { Readable } from 'node:stream'
import type { Database } from 'better-sqlite3'
import { findLibraryVideoPath } from './queries/library.js'
import { parseRange, resolveVideoPath } from './video.js'
function text(message: string, status: number): Response {
  return new Response(message, { status })
}
export function streamVideo(
  request: Request,
  db: Database,
  runsRoot: string,
  jobId: string,
): Response {
  const videoPath = findLibraryVideoPath(db, jobId)
  if (videoPath === null) return text('no library row for this job', 404)

  // The path comes from the database, never the URL — and is still
  // containment-checked, so a malformed row cannot read outside runs/.
  const absolute = resolveVideoPath(runsRoot, videoPath)
  if (absolute === null) return text('video path outside the runs root', 403)

  let size: number
  try {
    size = statSync(absolute).size
  } catch {
    return text('video file missing on disk', 404)
  }

  const range = parseRange(request.headers.get('range') ?? undefined, size)
  const stream = Readable.toWeb(createReadStream(absolute, range ?? undefined)) as ReadableStream
  return new Response(stream, {
    status: range ? 206 : 200,
    headers: {
      'content-type': 'video/mp4',
      'content-length': String(range ? range.end - range.start + 1 : size),
      ...(range && { 'content-range': `bytes ${range.start}-${range.end}/${size}` }),
      'accept-ranges': 'bytes',
    },
  })
}
