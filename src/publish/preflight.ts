import type { Database } from 'better-sqlite3'
import type { ObjectStore } from '../storage/types.js'
import { IG_PRESIGN_TTL_SECONDS } from './platforms/instagram.js'
import { renderCaption } from './platform-meta.js'
import { resolvePlatformMeta, type Platform } from './types.js'

export interface PreflightCheck {
  name: 'http-status' | 'content-type' | 'byte-length' | 'mp4-header'
  passed: boolean
  detail: string
}

export interface PreflightResult {
  ok: boolean
  objectKey: string
  url: string
  caption: string
  checks: PreflightCheck[]
}

// Bytes 4..8 of any ISO-BMFF file are the 'ftyp' box type. Cheapest possible
// proof that what came back is a video and not an error page or a zero-fill.
function isMp4(body: Buffer): boolean {
  return body.length >= 8 && body.subarray(4, 8).toString('latin1') === 'ftyp'
}

/**
 * Verifies the ALREADY-STORED object — the one Meta will actually fetch —
 * rather than uploading a fresh copy (design spec §6).
 *
 * The failure modes this targets are the ones Meta reports uselessly, as an
 * opaque container ERROR many minutes later: a presigned URL that 403s on
 * clock skew, a bucket serving application/octet-stream, a zero-byte object
 * from a truncated upload.
 *
 * Never calls Meta, never mutates `publishes`, never burns quota, and never
 * deletes the object — under design spec decision 1 that object is the
 * durable copy of the video.
 */
export async function preflight(opts: {
  db: Database
  jobId: string
  platform: Platform
  store: ObjectStore
  fetchImpl?: typeof fetch
}): Promise<PreflightResult> {
  const fetchImpl = opts.fetchImpl ?? fetch
  const row = opts.db
    .prepare(
      `SELECT lo.object_key AS objectKey, lo.bytes AS bytes, l.metadata_json AS metadataJson, j.topic AS topic
       FROM library l
       JOIN jobs j ON j.id = l.job_id
       LEFT JOIN library_objects lo ON lo.job_id = l.job_id
       WHERE l.job_id = ?`,
    )
    .get(opts.jobId) as
    | { objectKey: string | null; bytes: number | null; metadataJson: string; topic: string }
    | undefined

  if (row === undefined) {
    throw new Error(`preflight: no library row for job ${opts.jobId}`)
  }
  if (row.objectKey === null || row.bytes === null) {
    throw new Error(
      `preflight: job ${opts.jobId} has no stored object — run \`brainrot resume ${opts.jobId}\` or \`brainrot library backfill-store\``,
    )
  }

  const url = await opts.store.presignGet(row.objectKey, IG_PRESIGN_TTL_SECONDS)
  const res = await fetchImpl(url)
  const body = Buffer.from(await res.arrayBuffer())
  const contentType = res.headers.get('content-type') ?? ''

  const checks: PreflightCheck[] = [
    {
      name: 'http-status',
      passed: res.status === 200,
      detail: `HTTP ${res.status}`,
    },
    {
      name: 'content-type',
      passed: contentType.startsWith('video/mp4'),
      detail: contentType === '' ? '(none)' : contentType,
    },
    {
      name: 'byte-length',
      passed: body.length === row.bytes,
      detail: `fetched ${body.length}, library_objects records ${row.bytes}`,
    },
    {
      name: 'mp4-header',
      passed: isMp4(body),
      detail: isMp4(body) ? "bytes 4-8 are 'ftyp'" : "bytes 4-8 are not 'ftyp'",
    },
  ]

  const meta = resolvePlatformMeta(row.metadataJson, opts.platform, row.topic)
  return {
    ok: checks.every((c) => c.passed),
    objectKey: row.objectKey,
    url,
    caption: renderCaption(meta),
    checks,
  }
}
