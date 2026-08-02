import type { Database } from 'better-sqlite3'
import { BrainrotError, errorMessage } from '../../errors.js'
import { IG_CONTENT_PUBLISH_SCOPE } from '../oauth-flow.js'
import { renderCaption } from '../../posts/meta.js'
import { loadToken, upsertToken } from '../tokens.js'
import { networkError, PublishError, PublishOutcomeUnknownError } from '../types.js'
import type { PublishAdapter } from '../types.js'
import type { InstagramOptions } from './options.js'
import { PLATFORM_QUOTAS } from './quota.js'

export const IG_GRAPH_VERSION = 'v21.0'
export const IG_UPLOAD_TIMEOUT_MS = 300_000 // 5 min, per HTTP call
export const IG_POLL_TIMEOUT_MS = 300_000 // 5 min total, well inside the 30-min publish lease
export const IG_POLL_INTERVAL_MS = 5_000
export const IG_TOKEN_REFRESH_WINDOW_MS = 10 * 24 * 60 * 60 * 1000 // 10 days (design spec decision 5)
// Meta fetches video_url during container processing, already bounded at
// IG_POLL_TIMEOUT_MS (5 min). Two hours is headroom for Meta-side retries
// while keeping the signed URL's lifetime bounded.
export const IG_PRESIGN_TTL_SECONDS = 7200

interface IgErrorBody {
  error?: { code?: number; message?: string }
}
// Meta error codes (design spec §6.2): 190 is an expired/invalid token; 4/17
// are rate-limit / usage-cap codes. Both take priority over the raw HTTP
// status, matching youtubeTarget's QUOTA_REASONS pattern of inspecting the
// body before falling back to status-only mapping.
const AUTH_CODES = new Set([190])
const QUOTA_CODES = new Set([4, 17])

async function mapIgHttpError(op: string, res: Response): Promise<PublishError> {
  const raw = await res.text().catch(() => '')
  let code: number | undefined
  try {
    code = (JSON.parse(raw) as IgErrorBody).error?.code
  } catch {
    // Non-JSON body: nothing to inspect, fall through to status-only mapping.
  }
  if (code !== undefined && AUTH_CODES.has(code)) {
    return new PublishError(`${op}: ${res.status} auth error: ${raw}`, 'auth')
  }
  if (code !== undefined && QUOTA_CODES.has(code)) {
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

async function createContainer(opts: {
  igUserId: string
  videoUrl: string
  caption: string
  shareToFeed: boolean
  token: string
  fetchImpl: typeof fetch
}): Promise<string> {
  const url = new URL(`https://graph.instagram.com/${IG_GRAPH_VERSION}/${opts.igUserId}/media`)
  url.searchParams.set('media_type', 'REELS')
  // graph.instagram.com (Instagram API with Instagram Login) does NOT honor
  // upload_type=resumable — it answers 400 "The parameter video_url is
  // required". Meta's servers fetch the video from this URL themselves, which
  // is why finished videos have to live somewhere publicly reachable.
  url.searchParams.set('video_url', opts.videoUrl)
  url.searchParams.set('caption', opts.caption)
  url.searchParams.set('share_to_feed', String(opts.shareToFeed))
  url.searchParams.set('access_token', opts.token)
  let res: Response
  try {
    res = await opts.fetchImpl(url.toString(), {
      method: 'POST',
      signal: AbortSignal.timeout(IG_UPLOAD_TIMEOUT_MS),
    })
  } catch (err) {
    throw networkError('instagramTarget: createContainer', IG_UPLOAD_TIMEOUT_MS, err)
  }
  if (!res.ok) throw await mapIgHttpError('instagramTarget: createContainer', res)
  let body: { id?: string }
  try {
    body = (await res.json()) as { id?: string }
  } catch {
    throw new PublishError(
      'instagramTarget: createContainer: malformed JSON in success response',
      'transient',
    )
  }
  if (!body.id) {
    throw new PublishError(
      'instagramTarget: createContainer: response carried no container id',
      'transient',
    )
  }
  return body.id
}

async function pollUntilFinished(opts: {
  containerId: string
  token: string
  fetchImpl: typeof fetch
  nowMs: () => number
}): Promise<void> {
  const deadline = opts.nowMs() + IG_POLL_TIMEOUT_MS
  for (;;) {
    const url = new URL(`https://graph.instagram.com/${IG_GRAPH_VERSION}/${opts.containerId}`)
    url.searchParams.set('fields', 'status_code,status')
    url.searchParams.set('access_token', opts.token)
    let res: Response
    try {
      res = await opts.fetchImpl(url.toString(), {
        signal: AbortSignal.timeout(IG_UPLOAD_TIMEOUT_MS),
      })
    } catch (err) {
      throw networkError('instagramTarget: pollUntilFinished', IG_UPLOAD_TIMEOUT_MS, err)
    }
    if (!res.ok) throw await mapIgHttpError('instagramTarget: pollUntilFinished', res)
    const body = (await res.json()) as { status_code?: string; status?: string }
    if (body.status_code === 'FINISHED') return
    if (body.status_code === 'ERROR' || body.status_code === 'EXPIRED') {
      // Meta puts the actual cause in `status` — most often a failure to fetch
      // video_url. Without it this reads as a bare "entered status ERROR".
      const detail = body.status === undefined ? '' : `: ${body.status}`
      throw new PublishError(
        `instagramTarget: container ${opts.containerId} entered status ${body.status_code}${detail}`,
        'rejected',
      )
    }
    if (opts.nowMs() >= deadline) {
      throw new PublishError(
        `instagramTarget: container ${opts.containerId} did not finish processing within ${IG_POLL_TIMEOUT_MS}ms`,
        'transient',
      )
    }
    await new Promise((resolve) => setTimeout(resolve, IG_POLL_INTERVAL_MS))
  }
}

async function publishContainer(opts: {
  igUserId: string
  containerId: string
  token: string
  fetchImpl: typeof fetch
}): Promise<string> {
  const url = new URL(
    `https://graph.instagram.com/${IG_GRAPH_VERSION}/${opts.igUserId}/media_publish`,
  )
  url.searchParams.set('creation_id', opts.containerId)
  url.searchParams.set('access_token', opts.token)
  let res: Response
  try {
    res = await opts.fetchImpl(url.toString(), {
      method: 'POST',
      signal: AbortSignal.timeout(IG_UPLOAD_TIMEOUT_MS),
    })
  } catch (err) {
    throw networkError('instagramTarget: publishContainer', IG_UPLOAD_TIMEOUT_MS, err)
  }
  // Past this point the post is live whatever the body says — same
  // "irreversible point" rule as youtubeTarget (design spec §6.1).
  if (!res.ok) throw await mapIgHttpError('instagramTarget: publishContainer', res)
  let body: { id?: string }
  try {
    body = (await res.json()) as { id?: string }
  } catch {
    throw new PublishOutcomeUnknownError(
      'instagramTarget: accepted media_publish but returned a malformed JSON success body',
    )
  }
  if (!body.id) {
    throw new PublishOutcomeUnknownError(
      'instagramTarget: accepted media_publish but its success body carried no media id',
    )
  }
  return body.id
}

// Best-effort only (design spec §6.1): every failure here — network, non-2xx,
// malformed body — resolves to '' rather than throwing. The publish already
// succeeded by the time this runs; a missing permalink must never fail it.
async function fetchPermalink(opts: {
  mediaId: string
  token: string
  fetchImpl: typeof fetch
}): Promise<string> {
  try {
    const url = new URL(`https://graph.instagram.com/${IG_GRAPH_VERSION}/${opts.mediaId}`)
    url.searchParams.set('fields', 'permalink')
    url.searchParams.set('access_token', opts.token)
    const res = await opts.fetchImpl(url.toString(), {
      signal: AbortSignal.timeout(IG_UPLOAD_TIMEOUT_MS),
    })
    if (!res.ok) return ''
    const body = (await res.json()) as { permalink?: string }
    return body.permalink ?? ''
  } catch {
    return ''
  }
}

/**
 * The Instagram Reels container flow (design spec §6): presign -> create ->
 * poll -> publish -> permalink. Meta's Instagram API with Instagram Login
 * host (graph.instagram.com) has no resumable byte-upload path — it fetches
 * the video itself from a `video_url` we hand it, so a presigned URL has to
 * exist before any container does. `nowMs` is injectable so a poll-timeout
 * test never waits IG_POLL_TIMEOUT_MS of wall-clock time.
 */
export function instagramUploadTarget(
  fetchImpl: typeof fetch = fetch,
  nowMs: () => number = () => Date.now(),
): Pick<PublishAdapter<InstagramOptions>, 'platformId' | 'upload'> {
  return {
    platformId: 'instagram',
    async upload(req, token) {
      // Presign BEFORE any network call to Meta: a video with no stored
      // object must fail before a container is created that would just sit
      // and expire.
      const videoUrl = await req.media.url(IG_PRESIGN_TTL_SECONDS)
      const caption = renderCaption(req.meta)
      const containerId = await createContainer({
        igUserId: req.options.igUserId,
        videoUrl,
        caption,
        shareToFeed: req.options.shareToFeed,
        token,
        fetchImpl,
      })
      await pollUntilFinished({ containerId, token, fetchImpl, nowMs })
      const mediaId = await publishContainer({
        igUserId: req.options.igUserId,
        containerId,
        token,
        fetchImpl,
      })
      const url = await fetchPermalink({ mediaId, token, fetchImpl })
      return { postId: mediaId, url }
    },
  }
}

// The token runInstagramAuthFlow mints is an Instagram API with Instagram
// Login long-lived token, renewed via graph.instagram.com's ig_refresh_token
// grant — unlike Facebook Login for Business's fb_exchange_token exchange,
// this needs no app id/secret, only the current (non-expired, 24h+ old)
// long-lived token itself. Any failure here — network or HTTP — is caught
// and remapped to a single PublishError('auth') by resolveCredential below
// (design spec §5): the distinction between "network blip" and "token
// actually dead" does not change what the operator does next.
export async function refreshLongLivedToken(opts: {
  token: string
  fetchImpl: typeof fetch
}): Promise<{ token: string; expiresAt: string }> {
  const url = new URL('https://graph.instagram.com/refresh_access_token')
  url.searchParams.set('grant_type', 'ig_refresh_token')
  url.searchParams.set('access_token', opts.token)
  const res = await opts.fetchImpl(url.toString(), {
    signal: AbortSignal.timeout(IG_UPLOAD_TIMEOUT_MS),
  })
  if (!res.ok) {
    const raw = await res.text().catch(() => '')
    throw new BrainrotError(
      `refresh_access_token (ig_refresh_token) responded ${res.status}: ${raw}`,
      { domain: 'publish', kind: 'auth' },
    )
  }
  const body = (await res.json()) as { access_token?: string; expires_in?: number }
  if (!body.access_token || !body.expires_in) {
    throw new BrainrotError(
      'refresh_access_token (ig_refresh_token) response missing access_token/expires_in',
      { domain: 'publish', kind: 'auth' },
    )
  }
  return {
    token: body.access_token,
    expiresAt: new Date(Date.now() + body.expires_in * 1000).toISOString(),
  }
}

// Wraps instagramUploadTarget behind the PublishAdapter seam. Credential
// resolution is the piece unique to Instagram's token model: a long-lived
// token that IS the access token (no separate mint step), refreshed in place
// when within IG_TOKEN_REFRESH_WINDOW_MS of expiring (design spec decision 5).
export function instagramAdapter(
  fetchImpl: typeof fetch = fetch,
): PublishAdapter<InstagramOptions> {
  const target = instagramUploadTarget(fetchImpl)
  return {
    platformId: 'instagram',
    quota: PLATFORM_QUOTAS.instagram,
    // A Reel's permalink is keyed by an opaque shortcode the media id does
    // not contain, so there is nothing to build here — upload's own
    // best-effort fetchPermalink is the only source of an Instagram URL.
    postUrl: () => null,
    hasCredential(db: Database, channel: string, key: Buffer): boolean {
      return loadToken(db, 'instagram', channel, key) !== null
    },
    async resolveCredential(
      db: Database,
      channel: string,
      key: Buffer,
      now: Date,
    ): Promise<string> {
      const stored = loadToken(db, 'instagram', channel, key)
      if (stored === null) {
        throw new PublishError('instagramAdapter: no stored token for this channel', 'auth')
      }
      if (stored.expiresAt !== null) {
        const msUntilExpiry = new Date(stored.expiresAt).getTime() - now.getTime()
        if (msUntilExpiry <= IG_TOKEN_REFRESH_WINDOW_MS) {
          let refreshed: { token: string; expiresAt: string }
          try {
            refreshed = await refreshLongLivedToken({ token: stored.token, fetchImpl })
          } catch (err) {
            const message = errorMessage(err)
            throw new PublishError(`instagramAdapter: token refresh failed: ${message}`, 'auth')
          }
          upsertToken(
            db,
            'instagram',
            channel,
            refreshed.token,
            IG_CONTENT_PUBLISH_SCOPE,
            key,
            refreshed.expiresAt,
          )
          return refreshed.token
        }
      }
      return stored.token
    },
    upload: target.upload,
  }
}
