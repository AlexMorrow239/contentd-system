import { execa } from 'execa'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { YT_UPLOAD_SCOPE } from './platforms/youtube.js'

// Alex sits through this once per channel; 5 minutes covers a slow account
// picker or a 2FA prompt without leaving the loopback listener open forever.
export const AUTH_FLOW_TIMEOUT_MS = 300_000

// Desktop-app OAuth clients accept ANY loopback redirect URI (no pre-registration),
// so `open` plus a throwaway ephemeral port is the whole browser-launch story.
async function defaultOpenBrowser(url: string): Promise<void> {
  await execa('open', [url])
}

const REDIRECT_PAGE =
  '<!doctype html><html><body><p>Signed in. You can close this tab.</p></body></html>'

/**
 * One-shot interactive OAuth flow for a single YouTube channel grant:
 * loopback listener -> browser consent -> code exchange -> refresh token.
 * The server is always torn down (finally), win or lose, so a rejected or
 * timed-out flow never leaves a port open.
 */
export async function runYoutubeAuthFlow(opts: {
  clientId: string
  clientSecret: string
  openBrowser?: (url: string) => void | Promise<void>
  fetchImpl?: typeof fetch
  listenPort?: number
}): Promise<{ refreshToken: string; scopes: string }> {
  const openBrowser = opts.openBrowser ?? defaultOpenBrowser
  const fetchImpl = opts.fetchImpl ?? fetch
  const state = randomBytes(16).toString('hex')

  let resolveCode: (code: string) => void
  let rejectCode: (err: Error) => void
  const codeReceived = new Promise<string>((resolve, reject) => {
    resolveCode = resolve
    rejectCode = reject
  })
  // The state-mismatch branch below can reject this promise synchronously
  // while the redirect request is handled INSIDE the awaited openBrowser()
  // call — i.e. before Promise.race (below) has attached its own handler.
  // Without this no-op catch, Node flags that window as an unhandled
  // rejection (it's later "handled asynchronously", but the flag already
  // fired). This extra handler doesn't consume the rejection for the real
  // Promise.race consumer — it just keeps Node from complaining.
  codeReceived.catch(() => {})

  // Any mismatch between the state Google echoes back and the one this run
  // generated means the redirect did not originate from the consent screen
  // this process opened — reject before ever exchanging a code.
  const server = http.createServer((req, res) => {
    const redirectUrl = new URL(req.url ?? '/', 'http://127.0.0.1')
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end(REDIRECT_PAGE)
    if (redirectUrl.searchParams.get('state') !== state) {
      rejectCode(new Error('runYoutubeAuthFlow: state mismatch on redirect (possible CSRF)'))
      return
    }
    // Consent denial (?error=access_denied&state=...) echoes valid state but
    // carries no code — reject now rather than hang until the 5-min timeout.
    const error = redirectUrl.searchParams.get('error')
    if (error) {
      rejectCode(new Error(`runYoutubeAuthFlow: consent denied (${error})`))
      return
    }
    const code = redirectUrl.searchParams.get('code')
    if (code) resolveCode(code)
  })

  try {
    await new Promise<void>((resolve) => server.listen(opts.listenPort ?? 0, '127.0.0.1', resolve))
    const port = (server.address() as AddressInfo).port
    const redirectUri = `http://127.0.0.1:${port}`

    const consentUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth')
    consentUrl.searchParams.set('client_id', opts.clientId)
    consentUrl.searchParams.set('redirect_uri', redirectUri)
    consentUrl.searchParams.set('response_type', 'code')
    consentUrl.searchParams.set('scope', YT_UPLOAD_SCOPE)
    consentUrl.searchParams.set('access_type', 'offline')
    consentUrl.searchParams.set('prompt', 'consent')
    consentUrl.searchParams.set('state', state)

    await openBrowser(consentUrl.toString())

    const timeout = new Promise<never>((_, reject) => {
      setTimeout(
        () =>
          reject(
            new Error(
              `runYoutubeAuthFlow: timed out waiting for consent redirect after ${AUTH_FLOW_TIMEOUT_MS}ms`,
            ),
          ),
        AUTH_FLOW_TIMEOUT_MS,
      ).unref()
    })
    const code = await Promise.race([codeReceived, timeout])

    const tokenRes = await fetchImpl('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: opts.clientId,
        client_secret: opts.clientSecret,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
      }).toString(),
    })
    if (!tokenRes.ok) {
      throw new Error(`runYoutubeAuthFlow: token endpoint responded ${tokenRes.status}`)
    }
    const body = (await tokenRes.json()) as { refresh_token?: string; scope?: string }
    if (!body.refresh_token) {
      throw new Error(
        'runYoutubeAuthFlow: no refresh_token in response; remove prior grant at myaccount.google.com/permissions and retry',
      )
    }
    return { refreshToken: body.refresh_token, scopes: body.scope ?? YT_UPLOAD_SCOPE }
  } finally {
    server.closeAllConnections?.()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

// Scopes for "Instagram API with Instagram Login" (Business Login for
// Instagram) — the product provisioned by the App Dashboard's "Instagram
// API" use case. Development mode with the operator added as an Instagram
// tester needs no App Review for the operator's own accounts (design spec
// §12). These replace the older Facebook Login for Business scopes
// (instagram_content_publish/pages_show_list/business_management), which
// belong to a different Meta product this app is not configured for and
// which Meta's consent screen rejects as "Invalid Scopes" if requested here.
export const IG_CONTENT_PUBLISH_SCOPE =
  'instagram_business_basic,instagram_business_content_publish'

/**
 * One-shot interactive OAuth flow for a single Instagram channel grant, using
 * Business Login for Instagram: loopback listener -> instagram.com consent ->
 * code exchange -> long-lived token exchange. Structurally similar to
 * runYoutubeAuthFlow, with Meta's extra short-lived-to-long-lived exchange
 * step it does not need. The server is always torn down (finally), win or
 * lose.
 *
 * `appId`/`appSecret` here are the app's **Instagram App ID/Secret** —
 * shown on the "Instagram > API setup with Instagram login" page of the App
 * Dashboard — not the Facebook App ID shown at the top of the dashboard.
 * Those are two different credential pairs tied to two different login
 * products.
 */
// Meta requires an EXACT pre-registered redirect URI (unlike Google's
// installed-app clients, which accept any loopback port) — so unlike
// runYoutubeAuthFlow, this can't default to an OS-assigned ephemeral port.
// Register https://localhost:51834/ — protocol matters (see
// createSelfSignedHttpsServer below), and so does the trailing slash: the
// App Dashboard silently normalizes a saved redirect URI to end in one, and
// the code-exchange step (unlike the initial consent screen) validates
// against that exact registered string — as a Valid OAuth Redirect URI on
// the "Instagram > API setup with Instagram login" page before running
// `auth instagram`.
export const IG_AUTH_DEFAULT_PORT = 51834

// Minimal surface both http.Server and https.Server satisfy — narrow enough
// that a test fake can implement it with a plain http server, without this
// module caring which one it got.
interface LoopbackServer {
  on(event: 'request', listener: http.RequestListener): void
  listen(port: number, host: string, cb: () => void): unknown
  address(): AddressInfo | string | null
  close(cb: () => void): unknown
  closeAllConnections?(): void
}

// Meta's redirect-URI validator for Business Login for Instagram rejects a
// plain http:// URI even for localhost (unlike Google's installed-app OAuth,
// which YT_UPLOAD_SCOPE's flow relies on) — so the loopback listener has to
// actually terminate TLS, not just be reachable. A fresh self-signed cert
// per run (deleted from disk immediately after being read into memory) is
// simplest: no cert to manage between runs, and this is a rare
// once-per-channel interactive command, not a hot path. The browser will
// show a "connection not private" interstitial once per run (the cert isn't
// OS-trusted) — clicking through is expected, not a sign of failure.
export async function createSelfSignedHttpsServer(): Promise<{
  server: LoopbackServer
  protocol: 'https'
}> {
  const dir = mkdtempSync(join(tmpdir(), 'brainrot-ig-cert-'))
  const keyPath = join(dir, 'key.pem')
  const certPath = join(dir, 'cert.pem')
  try {
    await execa('openssl', [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-days',
      '1',
      '-nodes',
      '-subj',
      '/CN=localhost',
      '-keyout',
      keyPath,
      '-out',
      certPath,
    ])
    const key = readFileSync(keyPath)
    const cert = readFileSync(certPath)
    return { server: https.createServer({ key, cert }), protocol: 'https' }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

export async function runInstagramAuthFlow(opts: {
  appId: string
  appSecret: string
  openBrowser?: (url: string) => void | Promise<void>
  fetchImpl?: typeof fetch
  listenPort?: number
  createServer?: () => Promise<{ server: LoopbackServer; protocol: 'http' | 'https' }>
}): Promise<{ token: string; scopes: string; expiresAt: string }> {
  const openBrowser = opts.openBrowser ?? defaultOpenBrowser
  const fetchImpl = opts.fetchImpl ?? fetch
  const state = randomBytes(16).toString('hex')

  let resolveCode: (code: string) => void
  let rejectCode: (err: Error) => void
  const codeReceived = new Promise<string>((resolve, reject) => {
    resolveCode = resolve
    rejectCode = reject
  })
  codeReceived.catch(() => {})

  const { server, protocol } = await (opts.createServer ?? createSelfSignedHttpsServer)()
  server.on('request', (req, res) => {
    const redirectUrl = new URL(req.url ?? '/', 'http://127.0.0.1')
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end(REDIRECT_PAGE)
    if (redirectUrl.searchParams.get('state') !== state) {
      rejectCode(new Error('runInstagramAuthFlow: state mismatch on redirect (possible CSRF)'))
      return
    }
    const error = redirectUrl.searchParams.get('error')
    if (error) {
      rejectCode(new Error(`runInstagramAuthFlow: consent denied (${error})`))
      return
    }
    const code = redirectUrl.searchParams.get('code')
    if (code) resolveCode(code)
  })

  try {
    await new Promise<void>((resolve) =>
      server.listen(opts.listenPort ?? IG_AUTH_DEFAULT_PORT, '127.0.0.1', resolve),
    )
    const port = (server.address() as AddressInfo).port
    // Trailing slash is required: the App Dashboard silently normalizes a
    // saved redirect URI to end in one, and the token-exchange step (unlike
    // the initial consent screen) validates the redirect_uri it's given
    // against that registered value with an exact string match.
    const redirectUri = `${protocol}://localhost:${port}/`

    const consentUrl = new URL('https://www.instagram.com/oauth/authorize')
    consentUrl.searchParams.set('client_id', opts.appId)
    consentUrl.searchParams.set('redirect_uri', redirectUri)
    consentUrl.searchParams.set('response_type', 'code')
    consentUrl.searchParams.set('scope', IG_CONTENT_PUBLISH_SCOPE)
    consentUrl.searchParams.set('state', state)
    // This app is provisioned for Instagram Login only (no Facebook Login
    // for Business product added) — suppress the "log in with Facebook"
    // alternative Meta shows by default, since picking it would fail here.
    consentUrl.searchParams.set('enable_fb_login', 'false')

    await openBrowser(consentUrl.toString())

    const timeout = new Promise<never>((_, reject) => {
      setTimeout(
        () =>
          reject(
            new Error(
              `runInstagramAuthFlow: timed out waiting for consent redirect after ${AUTH_FLOW_TIMEOUT_MS}ms`,
            ),
          ),
        AUTH_FLOW_TIMEOUT_MS,
      ).unref()
    })
    const code = await Promise.race([codeReceived, timeout])

    // Step 1: exchange the code for a short-lived user access token. Unlike
    // Facebook Login's GET-with-query-params token endpoint, Instagram
    // Login's is a POST with a form-encoded body.
    const shortRes = await fetchImpl('https://api.instagram.com/oauth/access_token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: opts.appId,
        client_secret: opts.appSecret,
        grant_type: 'authorization_code',
        redirect_uri: redirectUri,
        code,
      }).toString(),
    })
    if (!shortRes.ok) {
      const raw = await shortRes.text().catch(() => '')
      throw new Error(`runInstagramAuthFlow: code exchange responded ${shortRes.status}: ${raw}`)
    }
    const shortBody = (await shortRes.json()) as { access_token?: string }
    if (!shortBody.access_token) {
      throw new Error('runInstagramAuthFlow: code exchange returned no access_token')
    }

    // Step 2: exchange the short-lived token for a ~60-day long-lived token.
    const longUrl = new URL('https://graph.instagram.com/access_token')
    longUrl.searchParams.set('grant_type', 'ig_exchange_token')
    longUrl.searchParams.set('client_secret', opts.appSecret)
    longUrl.searchParams.set('access_token', shortBody.access_token)
    const longRes = await fetchImpl(longUrl.toString())
    if (!longRes.ok) {
      const raw = await longRes.text().catch(() => '')
      throw new Error(
        `runInstagramAuthFlow: long-lived exchange responded ${longRes.status}: ${raw}`,
      )
    }
    const longBody = (await longRes.json()) as { access_token?: string; expires_in?: number }
    if (!longBody.access_token || !longBody.expires_in) {
      throw new Error(
        'runInstagramAuthFlow: long-lived exchange returned no access_token/expires_in',
      )
    }
    return {
      token: longBody.access_token,
      scopes: IG_CONTENT_PUBLISH_SCOPE,
      expiresAt: new Date(Date.now() + longBody.expires_in * 1000).toISOString(),
    }
  } finally {
    server.closeAllConnections?.()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}
