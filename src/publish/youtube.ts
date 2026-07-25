import { readFileSync } from 'node:fs'
import { renderDescription } from './platform-meta.js'
import { PublishError } from './types.js'
import type { PublishTarget } from './types.js'

// Least-privilege scope: upload-only, no read/manage access to the channel
// (design spec §4.2).
export const YT_UPLOAD_SCOPE = 'https://www.googleapis.com/auth/youtube.upload'

// Applies per HTTP call in the resumable upload (initiate, then the PUT of
// the file bytes) — not to the upload as a whole.
export const UPLOAD_TIMEOUT_MS = 300_000 // 5 min

// YouTube quota is per Google Cloud project (~10k units/day, 1600/upload),
// not per channel — this is the hard pre-upload gate counted across every
// channel (design spec decision 10).
export const DEFAULT_YT_UPLOADS_PER_DAY = 6

// Parsed at call time (not module load) so tests and long-lived processes see
// env changes without a re-import — same convention as costs.ts's
// globalDailyCapMicros.
export function ytUploadsPerDayCap(): number {
  const raw = process.env.BRAINROT_YT_UPLOADS_PER_DAY
  if (raw === undefined || raw.trim() === '') {
    return DEFAULT_YT_UPLOADS_PER_DAY
  }
  const n = Number(raw)
  // Integer-only: the tick gates on `used >= cap`, so a fractional 1.5 would
  // permit 2 uploads — a cap that silently rounds itself up.
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(
      `invalid BRAINROT_YT_UPLOADS_PER_DAY: ${JSON.stringify(raw)} (expected a positive integer number of uploads)`,
    )
  }
  return n
}

// The platform ACCEPTED the upload — the video exists on YouTube — but its
// outcome is unreadable (broken success body, no video id). Deliberately NOT
// a PublishError: no failure kind fits, and marking the row failed would make
// the same video eligible again at the next slot, publishing it twice. The
// tick leaves the row 'claimed' so the repair sweep heals it to 'interrupted'
// — the designed "uploaded but DB state unknown" operator path.
export class PublishOutcomeUnknownError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PublishOutcomeUnknownError'
  }
}

// The public watch URL for an uploaded Short. Built here rather than at each
// call site so the upload path and the manual `publish mark-done` path can
// never record two different URLs for the same video.
export function youtubeShortsUrl(postId: string): string {
  return `https://youtube.com/shorts/${postId}`
}

const TOKEN_URL = 'https://oauth2.googleapis.com/token'

// A thrown fetch (network failure, or an aborted/timed-out request) always
// maps to 'transient' — the tick's next slot is the retry (design spec
// decision 7). Shared by mintAccessToken and youtubeTarget.upload below.
function networkError(op: string, err: unknown): PublishError {
  if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
    return new PublishError(`${op}: request timed out after ${UPLOAD_TIMEOUT_MS}ms`, 'transient')
  }
  return new PublishError(
    `${op}: request failed: ${err instanceof Error ? err.message : String(err)}`,
    'transient',
  )
}

export async function mintAccessToken(opts: {
  refreshToken: string
  clientId: string
  clientSecret: string
  fetchImpl?: typeof fetch
}): Promise<string> {
  const fetchImpl = opts.fetchImpl ?? fetch
  let res: Response
  try {
    res = await fetchImpl(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: opts.refreshToken,
        client_id: opts.clientId,
        client_secret: opts.clientSecret,
      }).toString(),
      signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
    })
  } catch (err) {
    throw networkError('mintAccessToken', err)
  }
  if (!res.ok) {
    const raw = await res.text().catch(() => '')
    // invalid_grant and every other 4xx are the caller's problem (revoked or
    // expired grant, bad client secret) — re-auth is the fix, not a retry.
    if (res.status >= 500) {
      throw new PublishError(`mintAccessToken: token endpoint responded ${res.status}: ${raw}`, 'transient')
    }
    throw new PublishError(`mintAccessToken: token endpoint responded ${res.status}: ${raw}`, 'auth')
  }
  // A 200 with an unparseable body is a broken success response, not a caller
  // fault — 'transient' so the next tick retries rather than forcing re-auth.
  let body: { access_token?: string }
  try {
    body = (await res.json()) as { access_token?: string }
  } catch {
    throw new PublishError('mintAccessToken: malformed JSON in success response', 'transient')
  }
  if (!body.access_token) {
    throw new PublishError('mintAccessToken: token response carried no access_token', 'auth')
  }
  return body.access_token
}

const INITIATE_URL =
  'https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status'

// Wire shape of a YouTube Data API error body — errors[].reason is where the
// quota-vs-everything-else distinction lives; the HTTP status alone is not
// enough (quota errors arrive as plain 403s, same as other permission 4xxs).
interface YoutubeErrorBody {
  error?: { errors?: Array<{ reason?: string }> }
}
const QUOTA_REASONS = new Set(['quotaExceeded', 'uploadLimitExceeded', 'dailyLimitExceeded'])

async function mapUploadHttpError(op: string, res: Response): Promise<PublishError> {
  const raw = await res.text().catch(() => '')
  let reasons: string[] = []
  try {
    const parsed = JSON.parse(raw) as YoutubeErrorBody
    reasons = (parsed.error?.errors ?? []).map((e) => e.reason).filter((r): r is string => Boolean(r))
  } catch {
    // Non-JSON body: nothing to inspect, fall through to status-only mapping.
  }
  if (reasons.some((r) => QUOTA_REASONS.has(r))) {
    return new PublishError(`${op}: ${res.status} quota error: ${raw}`, 'quota')
  }
  if (res.status === 401) {
    return new PublishError(`${op}: ${res.status} auth error: ${raw}`, 'auth')
  }
  if (res.status >= 500) {
    return new PublishError(`${op}: ${res.status} server error: ${raw}`, 'transient')
  }
  return new PublishError(`${op}: ${res.status} rejected: ${raw}`, 'rejected')
}

export function youtubeTarget(fetchImpl: typeof fetch = fetch): PublishTarget {
  return {
    platformId: 'youtube',
    async upload(req, accessToken) {
      const { videoPath, meta, publish } = req
      // The same helper resolvePlatformMeta bounds against the 5000-char limit,
      // so the checked form and the sent form cannot drift apart.
      const description = renderDescription(meta.description, meta.hashtags)
      const metadataBody = {
        snippet: {
          title: meta.title,
          description,
          tags: meta.hashtags.map((h) => h.replace(/^#/, '')),
          categoryId: String(publish.categoryId),
        },
        status: {
          privacyStatus: publish.privacy,
          selfDeclaredMadeForKids: publish.madeForKids,
          containsSyntheticMedia: true,
        },
      }

      // Read the file BEFORE the initiate POST: the resumable protocol wants
      // the byte length up front (X-Upload-Content-Length), and a missing file
      // must fail before any network call rather than after a wasted initiate.
      // Buffer<ArrayBuffer>, not the bare `Buffer` alias: an unparameterized
      // annotation widens the generic to Buffer<ArrayBufferLike>, which fetch's
      // BodyInit rejects (SharedArrayBuffer-shaped, not assignable) even though
      // readFileSync's own inferred return type satisfies it directly.
      let bytes: Buffer<ArrayBuffer>
      try {
        bytes = readFileSync(videoPath)
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          throw new PublishError(`youtubeTarget: video file not found at ${videoPath}`, 'rejected')
        }
        throw err
      }

      let initiateRes: Response
      try {
        initiateRes = await fetchImpl(INITIATE_URL, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
            'X-Upload-Content-Length': String(bytes.length),
            'X-Upload-Content-Type': 'video/mp4',
          },
          body: JSON.stringify(metadataBody),
          signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
        })
      } catch (err) {
        throw networkError('youtubeTarget', err)
      }
      if (!initiateRes.ok) {
        throw await mapUploadHttpError('youtubeTarget', initiateRes)
      }
      const location = initiateRes.headers.get('location')
      if (!location) {
        throw new PublishError('youtubeTarget: resumable initiate response carried no Location header', 'transient')
      }

      // The PUT to the session Location is its own authenticated request — the
      // Bearer token and content type are mandatory. Content-Length is NOT set
      // by hand: undici derives it from the Buffer body.
      let uploadRes: Response
      try {
        uploadRes = await fetchImpl(location, {
          method: 'PUT',
          headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'video/mp4' },
          body: bytes,
          signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
        })
      } catch (err) {
        throw networkError('youtubeTarget', err)
      }
      if (!uploadRes.ok) {
        throw await mapUploadHttpError('youtubeTarget', uploadRes)
      }
      // Past this point the bytes are accepted: the video is live on YouTube
      // whatever the body says. An unreadable body is therefore an unknown
      // outcome, never a retryable failure — a retry would upload the same
      // video a second time.
      let body: { id?: string }
      try {
        body = (await uploadRes.json()) as { id?: string }
      } catch {
        throw new PublishOutcomeUnknownError(
          'youtubeTarget: accepted the upload but returned a malformed JSON success body',
        )
      }
      if (!body.id) {
        throw new PublishOutcomeUnknownError(
          'youtubeTarget: accepted the upload but its success body carried no video id',
        )
      }
      return { postId: body.id, url: youtubeShortsUrl(body.id) }
    },
  }
}
