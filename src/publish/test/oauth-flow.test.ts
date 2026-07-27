import http from 'node:http'
import https from 'node:https'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  AUTH_FLOW_TIMEOUT_MS,
  createSelfSignedHttpsServer,
  IG_CONTENT_PUBLISH_SCOPE,
  runInstagramAuthFlow,
  runYoutubeAuthFlow,
} from '../oauth-flow.js'
import { YT_UPLOAD_SCOPE } from '../platforms/youtube.js'

// runInstagramAuthFlow's real server generates a self-signed TLS cert via
// openssl (see createSelfSignedHttpsServer) — real but slow, and a plain
// Node fetch() wouldn't trust the cert anyway. Tests inject a plain http
// server instead: the flow logic under test (state/error/code handling,
// redirect_uri round-tripping) doesn't depend on which protocol carries it.
function fakeHttpServer(): Promise<{ server: http.Server; protocol: 'http' }> {
  return Promise.resolve({ server: http.createServer(), protocol: 'http' })
}

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

describe('createSelfSignedHttpsServer', () => {
  it('produces a real HTTPS server a client can complete a TLS handshake against', async () => {
    const { server, protocol } = await createSelfSignedHttpsServer()
    expect(protocol).toBe('https')
    server.on('request', (req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end('ok')
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as AddressInfo).port
    try {
      // The cert is self-signed (not OS-trusted) by design — a real browser
      // shows a one-time click-through warning here; a test client opts out
      // of verification per-request instead, with no global process.env
      // mutation that could leak into other tests.
      const body = await new Promise<string>((resolve, reject) => {
        const req = https.get(
          { hostname: 'localhost', port, path: '/', rejectUnauthorized: false },
          (res) => {
            let data = ''
            res.on('data', (chunk: Buffer) => (data += chunk.toString()))
            res.on('end', () => resolve(data))
          },
        )
        req.on('error', reject)
      })
      expect(body).toBe('ok')
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  }, 15_000)
})

describe('runInstagramAuthFlow', () => {
  it('drives consent -> redirect -> two-step token exchange and returns a long-lived token', async () => {
    let callIndex = 0
    const fetchImpl: typeof fetch = async (url, init) => {
      callIndex++
      if (callIndex === 1) {
        // short-lived code exchange: POST with a form-encoded body
        expect(url).toBe('https://api.instagram.com/oauth/access_token')
        const params = new URLSearchParams(init?.body as string)
        expect(params.get('code')).toBe('test-auth-code')
        expect(params.get('client_id')).toBe('test-app-id')
        expect(params.get('client_secret')).toBe('test-app-secret')
        expect(params.get('grant_type')).toBe('authorization_code')
        return new Response(JSON.stringify({ access_token: 'short-lived-token' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      // long-lived exchange
      const parsed = new URL(url instanceof Request ? url.url : String(url))
      expect(parsed.origin + parsed.pathname).toBe('https://graph.instagram.com/access_token')
      expect(parsed.searchParams.get('grant_type')).toBe('ig_exchange_token')
      expect(parsed.searchParams.get('client_secret')).toBe('test-app-secret')
      expect(parsed.searchParams.get('access_token')).toBe('short-lived-token')
      return new Response(
        JSON.stringify({ access_token: 'long-lived-token', expires_in: 5_184_000 }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }

    const openBrowser = async (url: string) => {
      const consentUrl = new URL(url)
      expect(consentUrl.origin + consentUrl.pathname).toBe(
        'https://www.instagram.com/oauth/authorize',
      )
      expect(consentUrl.searchParams.get('client_id')).toBe('test-app-id')
      expect(consentUrl.searchParams.get('scope')).toBe(IG_CONTENT_PUBLISH_SCOPE)
      expect(consentUrl.searchParams.get('enable_fb_login')).toBe('false')
      const state = consentUrl.searchParams.get('state')
      const redirectUri = consentUrl.searchParams.get('redirect_uri')
      await fetch(`${redirectUri}?code=test-auth-code&state=${state}`)
    }

    const result = await runInstagramAuthFlow({
      appId: 'test-app-id',
      appSecret: 'test-app-secret',
      listenPort: 0,
      openBrowser,
      fetchImpl,
      createServer: fakeHttpServer,
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
      await fetch(`${redirectUri}?error=access_denied&state=${state}`)
    }
    await expect(
      runInstagramAuthFlow({
        appId: 'a',
        appSecret: 'b',
        listenPort: 0,
        openBrowser,
        fetchImpl: async () => new Response('', { status: 200 }),
        createServer: fakeHttpServer,
      }),
    ).rejects.toThrow(/consent denied/)
  })

  it('surfaces the response body when the code exchange rejects the request', async () => {
    const openBrowser = async (url: string) => {
      const consentUrl = new URL(url)
      const state = consentUrl.searchParams.get('state')
      const redirectUri = consentUrl.searchParams.get('redirect_uri')
      await fetch(`${redirectUri}?code=test-auth-code&state=${state}`)
    }
    const fetchImpl: typeof fetch = async () =>
      new Response(JSON.stringify({ error_message: 'Invalid redirect_uri' }), { status: 400 })
    await expect(
      runInstagramAuthFlow({
        appId: 'a',
        appSecret: 'b',
        listenPort: 0,
        openBrowser,
        fetchImpl,
        createServer: fakeHttpServer,
      }),
    ).rejects.toThrow(/code exchange responded 400.*Invalid redirect_uri/s)
  })
})
