import type { Database } from 'better-sqlite3'
import { renderDescription, renderTags } from '../../posts/meta.js'
import { loadToken } from '../tokens.js'
import { networkError, PublishError, PublishOutcomeUnknownError } from '../types.js'
import type { PublishAdapter } from '../types.js'
import type { YoutubeOptions } from './options.js'
import { PLATFORM_QUOTAS } from './quota.js'

// Least-privilege scope: upload-only, no read/manage access to the channel
// (design spec §4.2).
export const YT_UPLOAD_SCOPE = 'https://www.googleapis.com/auth/youtube.upload'

// Applies per HTTP call in the resumable upload (initiate, then the PUT of
// the file bytes) — not to the upload as a whole.
export const UPLOAD_TIMEOUT_MS = 300_000 // 5 min

// The public watch URL for an uploaded Short. Built here rather than at each
// call site so the upload path and the manual `publish mark-done` path can
// never record two different URLs for the same video.
export function youtubeShortsUrl(postId: string): string {
  return `https://youtube.com/shorts/${postId}`
}

const TOKEN_URL = 'https://oauth2.googleapis.com/token'

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
    throw networkError('mintAccessToken', UPLOAD_TIMEOUT_MS, err)
  }
  if (!res.ok) {
    const raw = await res.text().catch(() => '')
    // invalid_grant and every other 4xx are the caller's problem (revoked or
    // expired grant, bad client secret) — re-auth is the fix, not a retry.
    if (res.status >= 500) {
      throw new PublishError(
        `mintAccessToken: token endpoint responded ${res.status}: ${raw}`,
        'transient',
      )
    }
    throw new PublishError(
      `mintAccessToken: token endpoint responded ${res.status}: ${raw}`,
      'auth',
    )
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
    reasons = (parsed.error?.errors ?? [])
      .map((e) => e.reason)
      .filter((r): r is string => Boolean(r))
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

// PublishTarget (the pre-Task-2 return type here) was folded into the more
// general PublishAdapter (types.ts) and no longer exists as its own type —
// this Pick is the two members youtubeTarget still furnishes on its own
// (upload mechanics), with the rest (quota, credential resolution) added by
// youtubeAdapter below. The req shape changes from the old ad-hoc `publish:
// PublishChannelConfig` to `options: YoutubeOptions` accordingly — same
// three fields (privacy/categoryId/madeForKids), just under the name the
// adapter contract now uses.
export function youtubeTarget(
  fetchImpl: typeof fetch = fetch,
): Pick<PublishAdapter<YoutubeOptions>, 'platformId' | 'upload'> {
  return {
    platformId: 'youtube',
    async upload(req, accessToken) {
      const { media, meta, options } = req
      // The same helper resolvePlatformMeta bounds against the 5000-char limit,
      // so the checked form and the sent form cannot drift apart.
      const description = renderDescription(meta.description, meta.hashtags)
      const metadataBody = {
        snippet: {
          title: meta.title,
          description,
          tags: renderTags(meta.hashtags),
          categoryId: String(options.categoryId),
        },
        status: {
          privacyStatus: options.privacy,
          selfDeclaredMadeForKids: options.madeForKids,
          containsSyntheticMedia: true,
        },
      }

      // Resolved BEFORE the initiate POST: the resumable protocol wants the
      // byte length up front (X-Upload-Content-Length), and an unavailable
      // video must fail before any network call rather than after a wasted
      // initiate. media.bytes() itself raises a rejected PublishError when
      // neither the local file nor the object store has it.
      const bytes = await media.bytes()

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
        throw networkError('youtubeTarget', UPLOAD_TIMEOUT_MS, err)
      }
      if (!initiateRes.ok) {
        throw await mapUploadHttpError('youtubeTarget', initiateRes)
      }
      const location = initiateRes.headers.get('location')
      if (!location) {
        throw new PublishError(
          'youtubeTarget: resumable initiate response carried no Location header',
          'transient',
        )
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
        throw networkError('youtubeTarget', UPLOAD_TIMEOUT_MS, err)
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

// Wraps youtubeTarget/mintAccessToken (unchanged above) and the shared
// quota descriptor behind the PublishAdapter seam the tick drives
// generically (design spec
// §5). hasCredential mirrors exactly what the pre-adapter tick checked
// inline: client env presence, then a decryptable stored token — both cheap,
// no network, safe to run per-candidate before any claim.
export function youtubeAdapter(fetchImpl: typeof fetch = fetch): PublishAdapter<YoutubeOptions> {
  const target = youtubeTarget(fetchImpl)
  return {
    platformId: 'youtube',
    quota: PLATFORM_QUOTAS.youtube,
    postUrl: youtubeShortsUrl,
    hasCredential(db: Database, channel: string, key: Buffer): boolean {
      if (!process.env.YT_CLIENT_ID || !process.env.YT_CLIENT_SECRET) return false
      return loadToken(db, 'youtube', channel, key) !== null
    },
    async resolveCredential(db: Database, channel: string, key: Buffer): Promise<string> {
      const stored = loadToken(db, 'youtube', channel, key)
      if (stored === null) {
        throw new PublishError('youtubeAdapter: no stored token for this channel', 'auth')
      }
      const clientId = process.env.YT_CLIENT_ID
      const clientSecret = process.env.YT_CLIENT_SECRET
      if (!clientId || !clientSecret) {
        throw new PublishError('youtubeAdapter: YT_CLIENT_ID/YT_CLIENT_SECRET not set', 'auth')
      }
      return mintAccessToken({ refreshToken: stored.token, clientId, clientSecret, fetchImpl })
    },
    upload: target.upload,
  }
}
