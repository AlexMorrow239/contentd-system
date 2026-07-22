import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PlatformMeta, PublishChannelConfig } from './types.js'
import { PublishError } from './types.js'
import {
  DEFAULT_YT_UPLOADS_PER_DAY,
  UPLOAD_TIMEOUT_MS,
  YT_UPLOAD_SCOPE,
  mintAccessToken,
  youtubeTarget,
  ytUploadsPerDayCap,
} from './youtube.js'

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

  it('throws on a non-positive or non-numeric value', () => {
    vi.stubEnv('BRAINROT_YT_UPLOADS_PER_DAY', '0')
    expect(() => ytUploadsPerDayCap()).toThrow(/invalid BRAINROT_YT_UPLOADS_PER_DAY/)
    vi.stubEnv('BRAINROT_YT_UPLOADS_PER_DAY', 'abc')
    expect(() => ytUploadsPerDayCap()).toThrow(/invalid BRAINROT_YT_UPLOADS_PER_DAY/)
  })
})

// Injectable fetch: captures every call, answers with one canned response per
// call in sequence (used later for the resumable upload's two HTTP calls).
function fakeFetch(responses: Array<{ status: number; body?: unknown; headers?: Record<string, string> }>) {
  const calls: { url: string; init: RequestInit | undefined }[] = []
  let i = 0
  const impl: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), init })
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
    const { impl, calls } = fakeFetch([{ status: 200, body: { access_token: 'ya29.at-test', expires_in: 3600 } }])
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
      { status: 400, body: { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' } },
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
})

function tempVideoFile(bytes = 'fake video bytes'): string {
  const dir = mkdtempSync(join(tmpdir(), 'brainrot-yt-'))
  const path = join(dir, 'video.mp4')
  writeFileSync(path, bytes)
  return path
}

const META: PlatformMeta = { title: 'A great short', description: 'Watch this.', hashtags: ['#funny', '#shorts'] }
const META_NO_HASHTAGS: PlatformMeta = { title: 'A great short', description: 'Watch this.', hashtags: [] }
const PUBLISH_CFG: PublishChannelConfig = {
  slots: ['10:00'],
  platforms: ['youtube'],
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
    const res = await target.upload({ videoPath, meta: META, publish: PUBLISH_CFG }, 'access-token-x')

    expect(calls).toHaveLength(2)
    // Phase 1: resumable initiate — exact metadata body per the interface contract.
    expect(calls[0].url).toBe(
      'https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status',
    )
    const initInit = calls[0].init!
    expect(initInit.method).toBe('POST')
    expect((initInit.headers as Record<string, string>).Authorization).toBe('Bearer access-token-x')
    expect(JSON.parse(initInit.body as string)).toEqual({
      snippet: {
        title: 'A great short',
        description: 'Watch this.\n\n#funny #shorts',
        tags: ['funny', 'shorts'],
        categoryId: '24',
      },
      status: { privacyStatus: 'public', selfDeclaredMadeForKids: false, containsSyntheticMedia: true },
    })

    // Phase 2: PUT the raw bytes to the Location URL returned by phase 1.
    expect(calls[1].url).toBe('https://upload.example.com/session/abc123')
    const putInit = calls[1].init!
    expect(putInit.method).toBe('PUT')
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
    await target.upload({ videoPath, meta: META_NO_HASHTAGS, publish: PUBLISH_CFG }, 'access-token-x')
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
        .upload({ videoPath: tempVideoFile(), meta: META, publish: PUBLISH_CFG }, 'tok')
        .catch((e: unknown) => e)
      expect(err).toBeInstanceOf(PublishError)
      expect((err as PublishError).kind).toBe('quota')
    },
  )

  it('maps HTTP 401 to kind "auth"', async () => {
    const { impl } = fakeFetch([{ status: 401, body: { error: { errors: [{ reason: 'authError' }] } } }])
    const target = youtubeTarget(impl)
    const err = await target
      .upload({ videoPath: tempVideoFile(), meta: META, publish: PUBLISH_CFG }, 'tok')
      .catch((e: unknown) => e)
    expect(err).toBeInstanceOf(PublishError)
    expect((err as PublishError).kind).toBe('auth')
  })

  it('maps another 4xx to kind "rejected"', async () => {
    const { impl } = fakeFetch([{ status: 400, body: { error: { errors: [{ reason: 'invalidMetadata' }] } } }])
    const target = youtubeTarget(impl)
    const err = await target
      .upload({ videoPath: tempVideoFile(), meta: META, publish: PUBLISH_CFG }, 'tok')
      .catch((e: unknown) => e)
    expect(err).toBeInstanceOf(PublishError)
    expect((err as PublishError).kind).toBe('rejected')
  })

  it('maps a 5xx to kind "transient"', async () => {
    const { impl } = fakeFetch([{ status: 503, body: { error: { errors: [{ reason: 'backendError' }] } } }])
    const target = youtubeTarget(impl)
    const err = await target
      .upload({ videoPath: tempVideoFile(), meta: META, publish: PUBLISH_CFG }, 'tok')
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
      .upload({ videoPath: tempVideoFile(), meta: META, publish: PUBLISH_CFG }, 'tok')
      .catch((e: unknown) => e)
    expect(err).toBeInstanceOf(PublishError)
    expect((err as PublishError).kind).toBe('transient')
  })

  it('maps a missing local video file (ENOENT) to kind "rejected"', async () => {
    const { impl } = fakeFetch([{ status: 200, headers: { location: 'https://upload.example.com/session/ghost' } }])
    const target = youtubeTarget(impl)
    const err = await target
      .upload(
        { videoPath: '/nonexistent/brainrot-yt-missing/video.mp4', meta: META, publish: PUBLISH_CFG },
        'tok',
      )
      .catch((e: unknown) => e)
    expect(err).toBeInstanceOf(PublishError)
    expect((err as PublishError).kind).toBe('rejected')
  })
})
