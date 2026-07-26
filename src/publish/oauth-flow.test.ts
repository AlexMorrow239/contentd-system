import http from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  AUTH_FLOW_TIMEOUT_MS,
  IG_CONTENT_PUBLISH_SCOPE,
  runInstagramAuthFlow,
  runYoutubeAuthFlow,
} from './oauth-flow.js'
import { YT_UPLOAD_SCOPE } from './platforms/youtube.js'

describe('AUTH_FLOW_TIMEOUT_MS', () => {
  it('is 5 minutes', () => {
    expect(AUTH_FLOW_TIMEOUT_MS).toBe(300_000)
  })
})

describe('runYoutubeAuthFlow', () => {
  it('drives consent -> redirect -> exchange end-to-end and returns the refresh token', async () => {
    let redirectBody = ''
    const fetchImpl: typeof fetch = async (url, init) => {
      expect(url).toBe('https://oauth2.googleapis.com/token')
      const params = new URLSearchParams(init?.body as string)
      expect(params.get('code')).toBe('test-auth-code')
      expect(params.get('client_id')).toBe('test-client-id')
      expect(params.get('client_secret')).toBe('test-client-secret')
      expect(params.get('grant_type')).toBe('authorization_code')
      expect(params.get('redirect_uri')).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
      return new Response(
        JSON.stringify({ refresh_token: 'rt-test-token', scope: YT_UPLOAD_SCOPE }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }

    const openBrowser = async (url: string) => {
      const consentUrl = new URL(url)
      expect(consentUrl.origin + consentUrl.pathname).toBe(
        'https://accounts.google.com/o/oauth2/v2/auth',
      )
      expect(consentUrl.searchParams.get('client_id')).toBe('test-client-id')
      expect(consentUrl.searchParams.get('response_type')).toBe('code')
      expect(consentUrl.searchParams.get('scope')).toBe(YT_UPLOAD_SCOPE)
      expect(consentUrl.searchParams.get('access_type')).toBe('offline')
      expect(consentUrl.searchParams.get('prompt')).toBe('consent')
      const state = consentUrl.searchParams.get('state')
      expect(state).toMatch(/^[0-9a-f]{32}$/)
      const redirectUri = consentUrl.searchParams.get('redirect_uri')
      const res = await fetch(`${redirectUri}/?code=test-auth-code&state=${state}`)
      redirectBody = await res.text()
    }

    const result = await runYoutubeAuthFlow({
      clientId: 'test-client-id',
      clientSecret: 'test-client-secret',
      listenPort: 0,
      openBrowser,
      fetchImpl,
    })

    expect(result).toEqual({ refreshToken: 'rt-test-token', scopes: YT_UPLOAD_SCOPE })
    expect(redirectBody).toContain('close this tab')
  })

  it('rejects with a message telling the operator to remove the prior grant when the exchange returns no refresh_token', async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response(JSON.stringify({ scope: YT_UPLOAD_SCOPE }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })

    const openBrowser = async (url: string) => {
      const consentUrl = new URL(url)
      const state = consentUrl.searchParams.get('state')
      const redirectUri = consentUrl.searchParams.get('redirect_uri')
      await fetch(`${redirectUri}/?code=test-auth-code&state=${state}`)
    }

    await expect(
      runYoutubeAuthFlow({
        clientId: 'test-client-id',
        clientSecret: 'test-client-secret',
        listenPort: 0,
        openBrowser,
        fetchImpl,
      }),
    ).rejects.toThrow(
      'runYoutubeAuthFlow: no refresh_token in response; remove prior grant at myaccount.google.com/permissions and retry',
    )
  })

  it('rejects when the redirect state does not match the one sent to Google', async () => {
    const fetchImpl: typeof fetch = async () => {
      throw new Error('fetchImpl must not be called on a state mismatch')
    }

    const openBrowser = async (url: string) => {
      const consentUrl = new URL(url)
      const redirectUri = consentUrl.searchParams.get('redirect_uri')
      await fetch(`${redirectUri}/?code=test-auth-code&state=wrong-state`)
    }

    await expect(
      runYoutubeAuthFlow({
        clientId: 'test-client-id',
        clientSecret: 'test-client-secret',
        listenPort: 0,
        openBrowser,
        fetchImpl,
      }),
    ).rejects.toThrow('runYoutubeAuthFlow: state mismatch on redirect (possible CSRF)')
  })

  it('rejects promptly when the consent redirect carries an error (denial) instead of a code', async () => {
    const fetchImpl: typeof fetch = async () => {
      throw new Error('fetchImpl must not be called on a consent denial')
    }

    const openBrowser = async (url: string) => {
      const consentUrl = new URL(url)
      const state = consentUrl.searchParams.get('state')
      const redirectUri = consentUrl.searchParams.get('redirect_uri')
      // Google's denial redirect: valid state, no code, an error param.
      await fetch(`${redirectUri}/?error=access_denied&state=${state}`)
    }

    await expect(
      runYoutubeAuthFlow({
        clientId: 'test-client-id',
        clientSecret: 'test-client-secret',
        listenPort: 0,
        openBrowser,
        fetchImpl,
      }),
    ).rejects.toThrow('runYoutubeAuthFlow: consent denied (access_denied)')
  })

  // Every other case drives the redirect synchronously, so the 5-minute timeout
  // and the teardown that follows it never execute. Fake timers make the wait
  // instant; the port probe afterwards pins the finally-block close.
  it('rejects and frees the callback port when the consent redirect never arrives', async () => {
    let redirectPort = 0
    let markOpened: () => void
    const browserOpened = new Promise<void>((resolve) => {
      markOpened = resolve
    })
    // Consent opens and is then simply abandoned — no redirect ever reaches the
    // loopback listener.
    const openBrowser = async (url: string) => {
      const redirectUri = new URL(url).searchParams.get('redirect_uri') ?? ''
      redirectPort = Number(new URL(redirectUri).port)
      markOpened()
    }
    const fetchImpl: typeof fetch = async () => {
      throw new Error('fetchImpl must not be called on a timeout')
    }

    vi.useFakeTimers()
    const flow = runYoutubeAuthFlow({
      clientId: 'test-client-id',
      clientSecret: 'test-client-secret',
      listenPort: 0,
      openBrowser,
      fetchImpl,
    })
    const rejection = expect(flow).rejects.toThrow(
      `runYoutubeAuthFlow: timed out waiting for consent redirect after ${AUTH_FLOW_TIMEOUT_MS}ms`,
    )
    await browserOpened
    // A zero tick first: the flow only arms its timeout after openBrowser resolves.
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(AUTH_FLOW_TIMEOUT_MS)
    await rejection
    vi.useRealTimers()

    const probe = http.createServer()
    await new Promise<void>((resolve, reject) => {
      probe.once('error', reject)
      probe.listen(redirectPort, '127.0.0.1', resolve)
    })
    await new Promise<void>((resolve) => probe.close(() => resolve()))
  })

  afterEach(() => {
    vi.useRealTimers()
  })
})

describe('runInstagramAuthFlow', () => {
  it('drives consent -> redirect -> two-step token exchange and returns a long-lived token', async () => {
    let callIndex = 0
    const fetchImpl: typeof fetch = async (url) => {
      const parsed = new URL(String(url))
      callIndex++
      if (callIndex === 1) {
        // short-lived code exchange
        expect(parsed.searchParams.get('code')).toBe('test-auth-code')
        expect(parsed.searchParams.get('client_id')).toBe('test-app-id')
        expect(parsed.searchParams.get('client_secret')).toBe('test-app-secret')
        return new Response(JSON.stringify({ access_token: 'short-lived-token' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      // long-lived exchange
      expect(parsed.searchParams.get('grant_type')).toBe('fb_exchange_token')
      expect(parsed.searchParams.get('fb_exchange_token')).toBe('short-lived-token')
      return new Response(
        JSON.stringify({ access_token: 'long-lived-token', expires_in: 5_184_000 }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }

    const openBrowser = async (url: string) => {
      const consentUrl = new URL(url)
      expect(consentUrl.origin + consentUrl.pathname).toBe(
        'https://www.facebook.com/v21.0/dialog/oauth',
      )
      expect(consentUrl.searchParams.get('client_id')).toBe('test-app-id')
      expect(consentUrl.searchParams.get('scope')).toBe(IG_CONTENT_PUBLISH_SCOPE)
      const state = consentUrl.searchParams.get('state')
      const redirectUri = consentUrl.searchParams.get('redirect_uri')
      await fetch(`${redirectUri}/?code=test-auth-code&state=${state}`)
    }

    const result = await runInstagramAuthFlow({
      appId: 'test-app-id',
      appSecret: 'test-app-secret',
      listenPort: 0,
      openBrowser,
      fetchImpl,
    })

    expect(result.token).toBe('long-lived-token')
    expect(result.scopes).toBe(IG_CONTENT_PUBLISH_SCOPE)
    expect(new Date(result.expiresAt).getTime()).toBeGreaterThan(Date.now())
  })

  it('rejects when consent is denied', async () => {
    const openBrowser = async (url: string) => {
      const consentUrl = new URL(url)
      const state = consentUrl.searchParams.get('state')
      const redirectUri = consentUrl.searchParams.get('redirect_uri')
      await fetch(`${redirectUri}/?error=access_denied&state=${state}`)
    }
    await expect(
      runInstagramAuthFlow({
        appId: 'a',
        appSecret: 'b',
        listenPort: 0,
        openBrowser,
        fetchImpl: async () => new Response('', { status: 200 }),
      }),
    ).rejects.toThrow(/consent denied/)
  })
})
