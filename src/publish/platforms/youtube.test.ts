import { afterEach, describe, expect, it, vi } from 'vitest'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { publishMedia } from '../media.js'
import { upsertToken } from '../tokens.js'
import type { PlatformMeta, PublishMedia } from '../types.js'
import { PublishError, PublishOutcomeUnknownError } from '../types.js'
import type { YoutubeOptions } from './options.js'
import { DEFAULT_YT_UPLOADS_PER_DAY, ytUploadsPerDayCap } from './quota.js'
import {
  UPLOAD_TIMEOUT_MS,
  YT_UPLOAD_SCOPE,
  mintAccessToken,
  youtubeAdapter,
  youtubeTarget,
} from './youtube.js'
import { tmpDir } from '../../testing/tmp.js'
import { memDb } from '../../testing/db.js'

const TEST_KEY = Buffer.alloc(32, 0x42)

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('constants', () => {
  it('pins the upload scope, per-call timeout, and default daily cap', () => {
    expect(YT_UPLOAD_SCOPE).toBe('https://www.googleapis.com/auth/youtube.upload')
    expect(UPLOAD_TIMEOUT_MS).toBe(300_000)
    expect(DEFAULT_YT_UPLOADS_PER_DAY).toBe(6)
  })
})

describe('ytUploadsPerDayCap', () => {
  it('defaults to 6 when BRAINROT_YT_UPLOADS_PER_DAY is unset', () => {
    vi.stubEnv('BRAINROT_YT_UPLOADS_PER_DAY', undefined) // deterministic even if the shell exports it
    expect(ytUploadsPerDayCap()).toBe(6)
  })

  it('reads the env override at call time, not at import time', () => {
    vi.stubEnv('BRAINROT_YT_UPLOADS_PER_DAY', '10')
    expect(ytUploadsPerDayCap()).toBe(10)
    vi.stubEnv('BRAINROT_YT_UPLOADS_PER_DAY', '2')
    expect(ytUploadsPerDayCap()).toBe(2)
  })

  it('throws on a non-positive, non-numeric, or fractional value', () => {
    vi.stubEnv('BRAINROT_YT_UPLOADS_PER_DAY', '0')
    expect(() => ytUploadsPerDayCap()).toThrow(/invalid BRAINROT_YT_UPLOADS_PER_DAY/)
    vi.stubEnv('BRAINROT_YT_UPLOADS_PER_DAY', 'abc')
    expect(() => ytUploadsPerDayCap()).toThrow(/invalid BRAINROT_YT_UPLOADS_PER_DAY/)
    // A fraction would otherwise round the cap UP: the tick's `>=` gate lets
    // 2 uploads through at 1.5.
    vi.stubEnv('BRAINROT_YT_UPLOADS_PER_DAY', '1.5')
    expect(() => ytUploadsPerDayCap()).toThrow(/positive integer/)
  })
})

// Injectable fetch: captures every call, answers with one canned response per
// call in sequence (used later for the resumable upload's two HTTP calls).
function fakeFetch(
  responses: Array<{ status: number; body?: unknown; headers?: Record<string, string> }>,
) {
  const calls: { url: string; init: RequestInit | undefined }[] = []
  let i = 0
  const impl: typeof fetch = async (input, init) => {
    calls.push({ url: input instanceof Request ? input.url : String(input), init })
    const step = responses[i]
    i++
    return new Response(step.body === undefined ? '' : JSON.stringify(step.body), {
      status: step.status,
      headers: { 'content-type': 'application/json', ...step.headers },
    })
  }
  return { impl, calls }
}

describe('mintAccessToken', () => {
  it('POSTs a refresh_token grant and returns the access token', async () => {
    const { impl, calls } = fakeFetch([
      { status: 200, body: { access_token: 'ya29.at-test', expires_in: 3600 } },
    ])
    const token = await mintAccessToken({
      refreshToken: 'rt-test-token',
      clientId: 'client-id-x',
      clientSecret: 'client-secret-x',
      fetchImpl: impl,
    })
    expect(token).toBe('ya29.at-test')
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe('https://oauth2.googleapis.com/token')
    const init = calls[0].init!
    expect(init.method).toBe('POST')
    const params = new URLSearchParams(init.body as string)
    expect(params.get('grant_type')).toBe('refresh_token')
    expect(params.get('refresh_token')).toBe('rt-test-token')
    expect(params.get('client_id')).toBe('client-id-x')
    expect(params.get('client_secret')).toBe('client-secret-x')
  })

  it('maps an invalid_grant rejection to kind "auth"', async () => {
    const { impl } = fakeFetch([
      {
        status: 400,
        body: { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' },
      },
    ])
    const err = await mintAccessToken({
      refreshToken: 'rt-test-token',
      clientId: 'client-id-x',
      clientSecret: 'client-secret-x',
      fetchImpl: impl,
    }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(PublishError)
    expect((err as PublishError).kind).toBe('auth')
  })

  it('maps a 500 to kind "transient"', async () => {
    const { impl } = fakeFetch([{ status: 500, body: { error: 'server_error' } }])
    const err = await mintAccessToken({
      refreshToken: 'rt-test-token',
      clientId: 'client-id-x',
      clientSecret: 'client-secret-x',
      fetchImpl: impl,
    }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(PublishError)
    expect((err as PublishError).kind).toBe('transient')
  })

  it('maps a malformed JSON body on a 200 to kind "transient"', async () => {
    // 200 OK but unparseable — a broken success response, not a caller fault.
    const impl: typeof fetch = async () =>
      new Response('not json{', { status: 200, headers: { 'content-type': 'application/json' } })
    const err = await mintAccessToken({
      refreshToken: 'rt-test-token',
      clientId: 'client-id-x',
      clientSecret: 'client-secret-x',
      fetchImpl: impl,
    }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(PublishError)
    expect((err as PublishError).kind).toBe('transient')
  })
})

function tempVideoFile(bytes = 'fake video bytes'): string {
  const dir = tmpDir('brainrot-yt-')
  const path = join(dir, 'video.mp4')
  writeFileSync(path, bytes)
  return path
}

// Test media handle backed by a real local file, matching what the tick builds.
function testMedia(localPath: string): PublishMedia {
  return publishMedia({ objectKey: null, localPath, store: null })
}

const META: PlatformMeta = {
  title: 'A great short',
  description: 'Watch this.',
  hashtags: ['#funny', '#shorts'],
}
const META_NO_HASHTAGS: PlatformMeta = {
  title: 'A great short',
  description: 'Watch this.',
  hashtags: [],
}
const YOUTUBE_OPTS: YoutubeOptions = {
  privacy: 'public',
  categoryId: 24,
  madeForKids: false,
}

describe('youtubeTarget upload — resumable two-phase happy path', () => {
  it('POSTs the resumable-initiate metadata, then PUTs the file bytes to the Location URL', async () => {
    const videoPath = tempVideoFile('fake video bytes')
    const { impl, calls } = fakeFetch([
      { status: 200, headers: { location: 'https://upload.example.com/session/abc123' } },
      { status: 200, body: { id: 'yt-video-1' } },
    ])
    const target = youtubeTarget(impl)
    const res = await target.upload(
      { media: testMedia(videoPath), meta: META, options: YOUTUBE_OPTS },
      'access-token-x',
    )

    expect(calls).toHaveLength(2)
    // Phase 1: resumable initiate — exact metadata body per the interface contract.
    expect(calls[0].url).toBe(
      'https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status',
    )
    const initInit = calls[0].init!
    expect(initInit.method).toBe('POST')
    // Initiate carries the bearer, JSON content type, and the resumable
    // protocol's declared body length + media type.
    const initHeaders = initInit.headers as Record<string, string>
    expect(initHeaders.Authorization).toBe('Bearer access-token-x')
    expect(initHeaders['Content-Type']).toBe('application/json')
    expect(initHeaders['X-Upload-Content-Length']).toBe(
      String(Buffer.byteLength('fake video bytes')),
    )
    expect(initHeaders['X-Upload-Content-Type']).toBe('video/mp4')
    expect(JSON.parse(initInit.body as string)).toEqual({
      snippet: {
        title: 'A great short',
        description: 'Watch this.\n\n#funny #shorts',
        tags: ['funny', 'shorts'],
        categoryId: '24',
      },
      status: {
        privacyStatus: 'public',
        selfDeclaredMadeForKids: false,
        containsSyntheticMedia: true,
      },
    })

    // Phase 2: PUT the raw bytes to the Location URL returned by phase 1 — its
    // own authenticated request (bearer + video/mp4 content type).
    expect(calls[1].url).toBe('https://upload.example.com/session/abc123')
    const putInit = calls[1].init!
    expect(putInit.method).toBe('PUT')
    const putHeaders = putInit.headers as Record<string, string>
    expect(putHeaders.Authorization).toBe('Bearer access-token-x')
    expect(putHeaders['Content-Type']).toBe('video/mp4')
    expect((putInit.body as Buffer).toString()).toBe('fake video bytes')

    expect(res).toEqual({ postId: 'yt-video-1', url: 'https://youtube.com/shorts/yt-video-1' })
  })

  it('omits the separator and ships an empty tags array when hashtags is empty', async () => {
    const videoPath = tempVideoFile('x')
    const { impl, calls } = fakeFetch([
      { status: 200, headers: { location: 'https://upload.example.com/session/def456' } },
      { status: 200, body: { id: 'yt-video-2' } },
    ])
    const target = youtubeTarget(impl)
    await target.upload(
      { media: testMedia(videoPath), meta: META_NO_HASHTAGS, options: YOUTUBE_OPTS },
      'access-token-x',
    )
    const body = JSON.parse(calls[0].init!.body as string)
    expect(body.snippet.description).toBe('Watch this.')
    expect(body.snippet.tags).toEqual([])
  })
})

describe('youtubeTarget upload — error mapping', () => {
  it.each(['quotaExceeded', 'uploadLimitExceeded', 'dailyLimitExceeded'])(
    'maps a body reason of "%s" to kind "quota"',
    async (reason) => {
      const { impl } = fakeFetch([{ status: 403, body: { error: { errors: [{ reason }] } } }])
      const target = youtubeTarget(impl)
      const err = await target
        .upload({ media: testMedia(tempVideoFile()), meta: META, options: YOUTUBE_OPTS }, 'tok')
        .catch((e: unknown) => e)
      expect(err).toBeInstanceOf(PublishError)
      expect((err as PublishError).kind).toBe('quota')
    },
  )

  it('maps HTTP 401 to kind "auth"', async () => {
    const { impl } = fakeFetch([
      { status: 401, body: { error: { errors: [{ reason: 'authError' }] } } },
    ])
    const target = youtubeTarget(impl)
    const err = await target
      .upload({ media: testMedia(tempVideoFile()), meta: META, options: YOUTUBE_OPTS }, 'tok')
      .catch((e: unknown) => e)
    expect(err).toBeInstanceOf(PublishError)
    expect((err as PublishError).kind).toBe('auth')
  })

  it('maps another 4xx to kind "rejected"', async () => {
    const { impl } = fakeFetch([
      { status: 400, body: { error: { errors: [{ reason: 'invalidMetadata' }] } } },
    ])
    const target = youtubeTarget(impl)
    const err = await target
      .upload({ media: testMedia(tempVideoFile()), meta: META, options: YOUTUBE_OPTS }, 'tok')
      .catch((e: unknown) => e)
    expect(err).toBeInstanceOf(PublishError)
    expect((err as PublishError).kind).toBe('rejected')
  })

  it('maps a 5xx to kind "transient"', async () => {
    const { impl } = fakeFetch([
      { status: 503, body: { error: { errors: [{ reason: 'backendError' }] } } },
    ])
    const target = youtubeTarget(impl)
    const err = await target
      .upload({ media: testMedia(tempVideoFile()), meta: META, options: YOUTUBE_OPTS }, 'tok')
      .catch((e: unknown) => e)
    expect(err).toBeInstanceOf(PublishError)
    expect((err as PublishError).kind).toBe('transient')
  })

  it('maps a network failure (including an aborted/timed-out request) to kind "transient"', async () => {
    const impl: typeof fetch = async () => {
      const abortErr = new Error('fetch failed')
      abortErr.name = 'AbortError'
      throw abortErr
    }
    const target = youtubeTarget(impl)
    const err = await target
      .upload({ media: testMedia(tempVideoFile()), meta: META, options: YOUTUBE_OPTS }, 'tok')
      .catch((e: unknown) => e)
    expect(err).toBeInstanceOf(PublishError)
    expect((err as PublishError).kind).toBe('transient')
  })

  it('maps a missing local video file (ENOENT) to kind "rejected" before any network call', async () => {
    const { impl, calls } = fakeFetch([
      { status: 200, headers: { location: 'https://upload.example.com/session/ghost' } },
    ])
    const target = youtubeTarget(impl)
    const err = await target
      .upload(
        {
          media: testMedia('/nonexistent/brainrot-yt-missing/video.mp4'),
          meta: META,
          options: YOUTUBE_OPTS,
        },
        'tok',
      )
      .catch((e: unknown) => e)
    expect(err).toBeInstanceOf(PublishError)
    expect((err as PublishError).kind).toBe('rejected')
    // The read now precedes the initiate POST — a missing file fails cold.
    expect(calls).toHaveLength(0)
  })

  // The PUT returned 2xx: YouTube HAS the video. Neither of the two ways its
  // body can be unreadable is a failure kind — a 'transient' here would send
  // the same video up again at the next slot (a duplicate public upload), so
  // both raise PublishOutcomeUnknownError instead and the tick leaves the row
  // claimed for the sweep.
  it('raises PublishOutcomeUnknownError on a malformed JSON body on the 200 upload finalize', async () => {
    const videoPath = tempVideoFile('x')
    let call = 0
    const impl: typeof fetch = async () => {
      call++
      if (call === 1) {
        return new Response('', {
          status: 200,
          headers: { location: 'https://upload.example.com/session/xyz' },
        })
      }
      return new Response('not json{', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    const target = youtubeTarget(impl)
    const err = await target
      .upload({ media: testMedia(videoPath), meta: META, options: YOUTUBE_OPTS }, 'tok')
      .catch((e: unknown) => e)
    expect(err).toBeInstanceOf(PublishOutcomeUnknownError)
    expect(err).not.toBeInstanceOf(PublishError)
    expect((err as Error).message).toMatch(/accepted the upload/)
  })

  it('raises PublishOutcomeUnknownError when the 200 upload finalize carries no video id', async () => {
    const videoPath = tempVideoFile('x')
    const { impl } = fakeFetch([
      { status: 200, headers: { location: 'https://upload.example.com/session/noid' } },
      { status: 200, body: { kind: 'youtube#video' } },
    ])
    const target = youtubeTarget(impl)
    const err = await target
      .upload({ media: testMedia(videoPath), meta: META, options: YOUTUBE_OPTS }, 'tok')
      .catch((e: unknown) => e)
    expect(err).toBeInstanceOf(PublishOutcomeUnknownError)
    expect((err as Error).message).toMatch(/no video id/)
  })
})

describe('youtubeAdapter', () => {
  it('exposes a global-scope quota keyed to BRAINROT_YT_UPLOADS_PER_DAY', () => {
    const adapter = youtubeAdapter()
    expect(adapter.platformId).toBe('youtube')
    expect(adapter.quota.scope).toBe('global')
    expect(adapter.quota.envVar).toBe('BRAINROT_YT_UPLOADS_PER_DAY')
    expect(adapter.quota.cap()).toBe(DEFAULT_YT_UPLOADS_PER_DAY)
  })

  it('hasCredential is false when YT_CLIENT_ID is unset, even with a stored token', () => {
    vi.stubEnv('YT_CLIENT_ID', undefined)
    vi.stubEnv('YT_CLIENT_SECRET', 'secret')
    const db = memDb()
    upsertToken(db, 'youtube', 'chan', 'rt', 'scope', TEST_KEY)
    expect(youtubeAdapter().hasCredential(db, 'chan', TEST_KEY)).toBe(false)
  })

  it('hasCredential is false with no stored token, even with env set', () => {
    vi.stubEnv('YT_CLIENT_ID', 'id')
    vi.stubEnv('YT_CLIENT_SECRET', 'secret')
    const db = memDb()
    expect(youtubeAdapter().hasCredential(db, 'chan', TEST_KEY)).toBe(false)
  })

  it('hasCredential is true with both env and a stored token', () => {
    vi.stubEnv('YT_CLIENT_ID', 'id')
    vi.stubEnv('YT_CLIENT_SECRET', 'secret')
    const db = memDb()
    upsertToken(db, 'youtube', 'chan', 'rt', 'scope', TEST_KEY)
    expect(youtubeAdapter().hasCredential(db, 'chan', TEST_KEY)).toBe(true)
  })

  it('resolveCredential mints an access token from the stored refresh token', async () => {
    vi.stubEnv('YT_CLIENT_ID', 'id')
    vi.stubEnv('YT_CLIENT_SECRET', 'secret')
    const db = memDb()
    upsertToken(db, 'youtube', 'chan', 'rt-stored', 'scope', TEST_KEY)
    const fetchImpl: typeof fetch = async () =>
      new Response(JSON.stringify({ access_token: 'at-minted' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    const credential = await youtubeAdapter(fetchImpl).resolveCredential(
      db,
      'chan',
      TEST_KEY,
      new Date(),
    )
    expect(credential).toBe('at-minted')
  })

  it('resolveCredential throws PublishError(auth) with no stored token', async () => {
    vi.stubEnv('YT_CLIENT_ID', 'id')
    vi.stubEnv('YT_CLIENT_SECRET', 'secret')
    const db = memDb()
    await expect(
      youtubeAdapter().resolveCredential(db, 'chan', TEST_KEY, new Date()),
    ).rejects.toMatchObject({ kind: 'auth' })
  })

  it('resolveCredential throws PublishError(auth) when YT_CLIENT_ID/SECRET are unset, even with a stored token', async () => {
    vi.stubEnv('YT_CLIENT_ID', undefined)
    vi.stubEnv('YT_CLIENT_SECRET', undefined)
    const db = memDb()
    upsertToken(db, 'youtube', 'chan', 'rt-stored', 'scope', TEST_KEY)
    await expect(
      youtubeAdapter().resolveCredential(db, 'chan', TEST_KEY, new Date()),
    ).rejects.toMatchObject({ kind: 'auth' })
  })
})
