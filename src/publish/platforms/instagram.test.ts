import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from '../../db/index.js'
import { loadToken, upsertToken } from '../tokens.js'
import { PublishError, PublishOutcomeUnknownError } from '../types.js'
import {
  DEFAULT_IG_UPLOADS_PER_DAY,
  IG_GRAPH_VERSION,
  IG_POLL_INTERVAL_MS,
  IG_POLL_TIMEOUT_MS,
  igUploadsPerDayCap,
  instagramAdapter,
  instagramUploadTarget,
  refreshLongLivedToken,
} from './instagram.js'

const TEST_KEY = Buffer.alloc(32, 0x42)

afterEach(() => {
  vi.unstubAllEnvs()
  vi.useRealTimers()
})

describe('igUploadsPerDayCap', () => {
  it('defaults to 25', () => {
    vi.stubEnv('BRAINROT_IG_UPLOADS_PER_DAY', undefined)
    expect(igUploadsPerDayCap()).toBe(25)
    expect(DEFAULT_IG_UPLOADS_PER_DAY).toBe(25)
  })

  it('reads the env override at call time', () => {
    vi.stubEnv('BRAINROT_IG_UPLOADS_PER_DAY', '10')
    expect(igUploadsPerDayCap()).toBe(10)
  })

  it('throws on a non-positive, non-numeric, or fractional value', () => {
    vi.stubEnv('BRAINROT_IG_UPLOADS_PER_DAY', '0')
    expect(() => igUploadsPerDayCap()).toThrow(/invalid BRAINROT_IG_UPLOADS_PER_DAY/)
    vi.stubEnv('BRAINROT_IG_UPLOADS_PER_DAY', '1.5')
    expect(() => igUploadsPerDayCap()).toThrow(/positive integer/)
  })
})

function tmpVideoFile(bytes = 'fake mp4 bytes'): string {
  const dir = mkdtempSync(join(tmpdir(), 'ig-'))
  const file = join(dir, 'video.mp4')
  writeFileSync(file, bytes)
  return file
}

// Sequenced fake fetch: each call answers with the next canned response,
// or invokes a handler function for assertions on that call's request. Once
// `steps` is exhausted, the last entry repeats for every further call — a
// poll-forever handler at the end of the array is meant to answer every
// subsequent poll, not to fall off the array into an unrelated later step
// (or off the end entirely) once the loop legitimately re-polls.
function fakeFetch(
  steps: Array<
    | { status: number; body?: unknown }
    | ((url: string, init?: RequestInit) => { status: number; body?: unknown })
  >,
) {
  const calls: { url: string; init: RequestInit | undefined }[] = []
  let i = 0
  const impl: typeof fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : String(input)
    calls.push({ url, init })
    const step = steps[Math.min(i, steps.length - 1)]
    i++
    const resolved = typeof step === 'function' ? step(url, init) : step
    return new Response(resolved.body === undefined ? '' : JSON.stringify(resolved.body), {
      status: resolved.status,
      headers: { 'content-type': 'application/json' },
    })
  }
  return { impl, calls }
}

describe('instagramUploadTarget', () => {
  const options = { igUserId: '1784140000', shareToFeed: true }
  const meta = { title: 'Saturn', description: 'It floats.', hashtags: ['#space'] }

  it('drives create -> upload -> poll(FINISHED) -> publish -> permalink and returns postId/url', async () => {
    const { impl, calls } = fakeFetch([
      { status: 200, body: { id: 'container-1' } }, // create
      { status: 200, body: {} }, // upload bytes
      { status: 200, body: { status_code: 'FINISHED' } }, // poll
      { status: 200, body: { id: 'media-1' } }, // publish
      { status: 200, body: { permalink: 'https://instagram.com/reel/media-1' } }, // permalink
    ])
    const target = instagramUploadTarget(impl, () => 0)
    const result = await target.upload({ videoPath: tmpVideoFile(), meta, options }, 'ig-token')
    expect(result).toEqual({ postId: 'media-1', url: 'https://instagram.com/reel/media-1' })

    expect(calls[0].url).toContain(`/${IG_GRAPH_VERSION}/1784140000/media`)
    expect(calls[0].url).toContain('media_type=REELS')
    expect(calls[1].url).toContain('rupload.facebook.com')
    expect((calls[1].init?.headers as Record<string, string>).Authorization).toBe('OAuth ig-token')
    expect(calls[3].url).toContain('media_publish')
  })

  it('polls through IN_PROGRESS before FINISHED', async () => {
    let polls = 0
    const pollStep = () => {
      polls++
      return { status: 200, body: { status_code: polls < 2 ? 'IN_PROGRESS' : 'FINISHED' } }
    }
    const { impl } = fakeFetch([
      { status: 200, body: { id: 'container-1' } },
      { status: 200, body: {} },
      pollStep, // poll 1: IN_PROGRESS
      pollStep, // poll 2: FINISHED
      { status: 200, body: { id: 'media-1' } },
      { status: 200, body: { permalink: '' } },
    ])
    const videoPath = tmpVideoFile()
    vi.useFakeTimers()
    try {
      const result = instagramUploadTarget(impl).upload({ videoPath, meta, options }, 'ig-token')
      // The real IG_POLL_INTERVAL_MS wait between poll 1 and poll 2 is the
      // only real timer this run schedules — advancing past it lets the
      // rest of the chain (all plain promise microtasks) settle on its own.
      await vi.advanceTimersByTimeAsync(IG_POLL_INTERVAL_MS)
      await result
    } finally {
      vi.useRealTimers()
    }
    expect(polls).toBe(2)
  })

  it('maps a container status of ERROR to kind rejected', async () => {
    const { impl } = fakeFetch([
      { status: 200, body: { id: 'container-1' } },
      { status: 200, body: {} },
      { status: 200, body: { status_code: 'ERROR' } },
    ])
    const err = await instagramUploadTarget(impl, () => 0)
      .upload({ videoPath: tmpVideoFile(), meta, options }, 'ig-token')
      .catch((e: unknown) => e)
    expect(err).toBeInstanceOf(PublishError)
    expect((err as PublishError).kind).toBe('rejected')
  })

  it('maps a poll that never finishes within the timeout to kind transient', async () => {
    const { impl } = fakeFetch([
      { status: 200, body: { id: 'container-1' } },
      { status: 200, body: {} },
      () => ({ status: 200, body: { status_code: 'IN_PROGRESS' } }),
    ])
    const videoPath = tmpVideoFile()
    vi.useFakeTimers()
    let err: unknown
    try {
      const pending = instagramUploadTarget(impl)
        .upload({ videoPath, meta, options }, 'ig-token')
        .catch((e: unknown) => e)
      // Fake timers fake Date alongside setTimeout, so the default nowMs
      // (Date.now) advances in lockstep with this one call — it cascades
      // through every IG_POLL_INTERVAL_MS wait the loop schedules along the
      // way, well past IG_POLL_TIMEOUT_MS, without any real wall-clock wait.
      await vi.advanceTimersByTimeAsync(IG_POLL_TIMEOUT_MS + IG_POLL_INTERVAL_MS)
      err = await pending
    } finally {
      vi.useRealTimers()
    }
    expect(err).toBeInstanceOf(PublishError)
    expect((err as PublishError).kind).toBe('transient')
  })

  it('maps HTTP 401 during container create to kind auth', async () => {
    const { impl } = fakeFetch([
      { status: 401, body: { error: { code: 190, message: 'expired' } } },
    ])
    const err = await instagramUploadTarget(impl, () => 0)
      .upload({ videoPath: tmpVideoFile(), meta, options }, 'ig-token')
      .catch((e: unknown) => e)
    expect(err).toBeInstanceOf(PublishError)
    expect((err as PublishError).kind).toBe('auth')
  })

  it('maps a quota error code to kind quota', async () => {
    const { impl } = fakeFetch([
      { status: 400, body: { error: { code: 4, message: 'rate limit' } } },
    ])
    const err = await instagramUploadTarget(impl, () => 0)
      .upload({ videoPath: tmpVideoFile(), meta, options }, 'ig-token')
      .catch((e: unknown) => e)
    expect(err).toBeInstanceOf(PublishError)
    expect((err as PublishError).kind).toBe('quota')
  })

  it('maps a 500 to kind transient', async () => {
    const { impl } = fakeFetch([{ status: 500, body: { error: { message: 'server error' } } }])
    const err = await instagramUploadTarget(impl, () => 0)
      .upload({ videoPath: tmpVideoFile(), meta, options }, 'ig-token')
      .catch((e: unknown) => e)
    expect(err).toBeInstanceOf(PublishError)
    expect((err as PublishError).kind).toBe('transient')
  })

  it('throws PublishOutcomeUnknownError when media_publish succeeds with no id', async () => {
    const { impl } = fakeFetch([
      { status: 200, body: { id: 'container-1' } },
      { status: 200, body: {} },
      { status: 200, body: { status_code: 'FINISHED' } },
      { status: 200, body: {} }, // publish: 200 but no id
    ])
    const err = await instagramUploadTarget(impl, () => 0)
      .upload({ videoPath: tmpVideoFile(), meta, options }, 'ig-token')
      .catch((e: unknown) => e)
    expect(err).toBeInstanceOf(PublishOutcomeUnknownError)
  })

  it('falls back to an empty url when the permalink fetch fails, without failing the publish', async () => {
    const { impl } = fakeFetch([
      { status: 200, body: { id: 'container-1' } },
      { status: 200, body: {} },
      { status: 200, body: { status_code: 'FINISHED' } },
      { status: 200, body: { id: 'media-1' } },
      { status: 500, body: {} }, // permalink fails — must not fail the publish
    ])
    const result = await instagramUploadTarget(impl, () => 0).upload(
      { videoPath: tmpVideoFile(), meta, options },
      'ig-token',
    )
    expect(result).toEqual({ postId: 'media-1', url: '' })
  })

  it('rejects on a missing video file before any network call', async () => {
    const { impl, calls } = fakeFetch([])
    const err = await instagramUploadTarget(impl, () => 0)
      .upload({ videoPath: '/no/such/file.mp4', meta, options }, 'ig-token')
      .catch((e: unknown) => e)
    expect(err).toBeInstanceOf(PublishError)
    expect((err as PublishError).kind).toBe('rejected')
    expect(calls).toHaveLength(0)
  })

  it('renders the composed caption as the request caption', async () => {
    const { impl, calls } = fakeFetch([
      { status: 200, body: { id: 'container-1' } },
      { status: 200, body: {} },
      { status: 200, body: { status_code: 'FINISHED' } },
      { status: 200, body: { id: 'media-1' } },
      { status: 200, body: { permalink: '' } },
    ])
    await instagramUploadTarget(impl, () => 0).upload(
      { videoPath: tmpVideoFile(), meta, options },
      'ig-token',
    )
    const createUrl = new URL(calls[0].url)
    expect(createUrl.searchParams.get('caption')).toBe('Saturn\n\nIt floats.\n\n#space')
    expect(createUrl.searchParams.get('share_to_feed')).toBe('true')
  })
})

describe('refreshLongLivedToken', () => {
  it('re-runs the fb_exchange_token exchange against graph.facebook.com/oauth/access_token', async () => {
    const fetchImpl: typeof fetch = async (input) => {
      const url = new URL(input instanceof Request ? input.url : String(input))
      expect(url.hostname).toBe('graph.facebook.com')
      expect(url.pathname).toBe(`/${IG_GRAPH_VERSION}/oauth/access_token`)
      expect(url.searchParams.get('grant_type')).toBe('fb_exchange_token')
      expect(url.searchParams.get('client_id')).toBe('app-id')
      expect(url.searchParams.get('client_secret')).toBe('app-secret')
      expect(url.searchParams.get('fb_exchange_token')).toBe('old-token')
      return new Response(JSON.stringify({ access_token: 'new-token', expires_in: 5_184_000 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    const result = await refreshLongLivedToken({
      token: 'old-token',
      appId: 'app-id',
      appSecret: 'app-secret',
      fetchImpl,
    })
    expect(result.token).toBe('new-token')
    expect(new Date(result.expiresAt).getTime()).toBeGreaterThan(Date.now())
  })

  it('throws on a non-ok response', async () => {
    const fetchImpl: typeof fetch = async () => new Response('', { status: 400 })
    await expect(
      refreshLongLivedToken({ token: 't', appId: 'a', appSecret: 's', fetchImpl }),
    ).rejects.toThrow(/responded 400/)
  })
})

describe('instagramAdapter', () => {
  it('quota is channel-scoped, keyed to BRAINROT_IG_UPLOADS_PER_DAY', () => {
    const adapter = instagramAdapter()
    expect(adapter.quota.scope).toBe('channel')
    expect(adapter.quota.envVar).toBe('BRAINROT_IG_UPLOADS_PER_DAY')
  })

  it('hasCredential is true only with a stored token', () => {
    const db = openDb(':memory:')
    expect(instagramAdapter().hasCredential(db, 'chan', TEST_KEY)).toBe(false)
    upsertToken(db, 'instagram', 'chan', 'tok', 'scope', TEST_KEY, '2027-01-01T00:00:00.000Z')
    expect(instagramAdapter().hasCredential(db, 'chan', TEST_KEY)).toBe(true)
  })

  it('resolveCredential returns the stored token unchanged when far from expiry', async () => {
    const db = openDb(':memory:')
    const farExpiry = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()
    upsertToken(db, 'instagram', 'chan', 'tok-stored', 'scope', TEST_KEY, farExpiry)
    const credential = await instagramAdapter().resolveCredential(db, 'chan', TEST_KEY, new Date())
    expect(credential).toBe('tok-stored')
  })

  it('resolveCredential refreshes and persists a new token inside the refresh window', async () => {
    vi.stubEnv('IG_APP_ID', 'app-id')
    vi.stubEnv('IG_APP_SECRET', 'app-secret')
    const db = openDb(':memory:')
    const soonExpiry = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString() // inside 10-day window
    upsertToken(db, 'instagram', 'chan', 'tok-old', 'scope', TEST_KEY, soonExpiry)
    const fetchImpl: typeof fetch = async () =>
      new Response(JSON.stringify({ access_token: 'tok-new', expires_in: 5_184_000 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    const credential = await instagramAdapter(fetchImpl).resolveCredential(
      db,
      'chan',
      TEST_KEY,
      new Date(),
    )
    expect(credential).toBe('tok-new')
    expect(loadToken(db, 'instagram', 'chan', TEST_KEY)?.token).toBe('tok-new')
  })

  it('resolveCredential maps a failed refresh to PublishError(auth)', async () => {
    vi.stubEnv('IG_APP_ID', 'app-id')
    vi.stubEnv('IG_APP_SECRET', 'app-secret')
    const db = openDb(':memory:')
    const soonExpiry = new Date(Date.now() + 1 * 24 * 60 * 60 * 1000).toISOString()
    upsertToken(db, 'instagram', 'chan', 'tok-old', 'scope', TEST_KEY, soonExpiry)
    const fetchImpl: typeof fetch = async () => new Response('', { status: 500 })
    await expect(
      instagramAdapter(fetchImpl).resolveCredential(db, 'chan', TEST_KEY, new Date()),
    ).rejects.toMatchObject({ kind: 'auth' })
  })

  it('resolveCredential maps missing IG_APP_ID/IG_APP_SECRET to PublishError(auth) without calling fetch', async () => {
    vi.stubEnv('IG_APP_ID', undefined)
    vi.stubEnv('IG_APP_SECRET', undefined)
    const db = openDb(':memory:')
    const soonExpiry = new Date(Date.now() + 1 * 24 * 60 * 60 * 1000).toISOString()
    upsertToken(db, 'instagram', 'chan', 'tok-old', 'scope', TEST_KEY, soonExpiry)
    let called = false
    const fetchImpl: typeof fetch = async () => {
      called = true
      throw new Error('fetchImpl must not be called when app credentials are missing')
    }
    await expect(
      instagramAdapter(fetchImpl).resolveCredential(db, 'chan', TEST_KEY, new Date()),
    ).rejects.toMatchObject({ kind: 'auth' })
    expect(called).toBe(false)
  })

  it('resolveCredential throws PublishError(auth) with no stored token', async () => {
    const db = openDb(':memory:')
    await expect(
      instagramAdapter().resolveCredential(db, 'chan', TEST_KEY, new Date()),
    ).rejects.toMatchObject({ kind: 'auth' })
  })
})
