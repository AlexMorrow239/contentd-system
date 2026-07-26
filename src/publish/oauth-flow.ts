import { randomBytes } from 'node:crypto'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { execa } from 'execa'
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

// Facebook Login for Business scopes for a personal/business Meta app in
// development mode with the operator as a role user — no App Review
// required for the operator's own accounts (design spec §12).
export const IG_CONTENT_PUBLISH_SCOPE =
  'instagram_content_publish,pages_show_list,business_management'

/**
 * One-shot interactive OAuth flow for a single Instagram channel grant:
 * loopback listener -> Facebook consent -> code exchange -> long-lived token
 * exchange. Structurally identical to runYoutubeAuthFlow, with Meta's extra
 * short-lived-to-long-lived exchange step it does not need. The server is
 * always torn down (finally), win or lose.
 */
export async function runInstagramAuthFlow(opts: {
  appId: string
  appSecret: string
  openBrowser?: (url: string) => void | Promise<void>
  fetchImpl?: typeof fetch
  listenPort?: number
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

  const server = http.createServer((req, res) => {
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
    await new Promise<void>((resolve) => server.listen(opts.listenPort ?? 0, '127.0.0.1', resolve))
    const port = (server.address() as AddressInfo).port
    const redirectUri = `http://127.0.0.1:${port}`

    const consentUrl = new URL('https://www.facebook.com/v21.0/dialog/oauth')
    consentUrl.searchParams.set('client_id', opts.appId)
    consentUrl.searchParams.set('redirect_uri', redirectUri)
    consentUrl.searchParams.set('response_type', 'code')
    consentUrl.searchParams.set('scope', IG_CONTENT_PUBLISH_SCOPE)
    consentUrl.searchParams.set('state', state)

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

    // Step 1: exchange the code for a short-lived user access token.
    const codeUrl = new URL('https://graph.facebook.com/v21.0/oauth/access_token')
    codeUrl.searchParams.set('client_id', opts.appId)
    codeUrl.searchParams.set('client_secret', opts.appSecret)
    codeUrl.searchParams.set('redirect_uri', redirectUri)
    codeUrl.searchParams.set('code', code)
    const shortRes = await fetchImpl(codeUrl.toString())
    if (!shortRes.ok) {
      throw new Error(`runInstagramAuthFlow: code exchange responded ${shortRes.status}`)
    }
    const shortBody = (await shortRes.json()) as { access_token?: string }
    if (!shortBody.access_token) {
      throw new Error('runInstagramAuthFlow: code exchange returned no access_token')
    }

    // Step 2: exchange the short-lived token for a ~60-day long-lived token.
    const longUrl = new URL('https://graph.facebook.com/v21.0/oauth/access_token')
    longUrl.searchParams.set('grant_type', 'fb_exchange_token')
    longUrl.searchParams.set('client_id', opts.appId)
    longUrl.searchParams.set('client_secret', opts.appSecret)
    longUrl.searchParams.set('fb_exchange_token', shortBody.access_token)
    const longRes = await fetchImpl(longUrl.toString())
    if (!longRes.ok) {
      throw new Error(`runInstagramAuthFlow: long-lived exchange responded ${longRes.status}`)
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
