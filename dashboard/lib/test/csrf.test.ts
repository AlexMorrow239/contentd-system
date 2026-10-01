import { describe, expect, it } from 'vitest'
import { csrfFailure, mintCsrfToken } from '../csrf.js'

function req(headers: Record<string, string>): { header: (name: string) => string | undefined } {
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]))
  return { header: (name: string) => lower[name.toLowerCase()] }
}

describe('csrfFailure', () => {
  const token = 'tok'

  it('accepts a same-origin form post carrying the token', () => {
    expect(
      csrfFailure(
        req({
          host: '127.0.0.1:8787',
          origin: 'http://127.0.0.1:8787',
          'sec-fetch-site': 'same-origin',
          'x-contentd-csrf': token,
        }),
        token,
      ),
    ).toBeNull()
  })

  it('rejects a cross-site Sec-Fetch-Site even when the token is right', () => {
    // The classic attack: a page on evil.example submits a form to the
    // loopback dashboard. CORS does not block the submission, only the read.
    expect(
      csrfFailure(
        req({
          host: '127.0.0.1:8787',
          origin: 'http://evil.example',
          'sec-fetch-site': 'cross-site',
          'x-contentd-csrf': token,
        }),
        token,
      ),
    ).toContain('cross-site')
  })

  it('rejects an Origin whose host is not our own', () => {
    expect(
      csrfFailure(
        req({ host: '127.0.0.1:8787', origin: 'http://evil.example', 'x-contentd-csrf': token }),
        token,
      ),
    ).toContain('origin')
  })

  it('rejects a request with neither Origin nor Sec-Fetch-Site', () => {
    // curl sends neither. Scripting is what the CLI is for.
    expect(csrfFailure(req({ host: '127.0.0.1:8787', 'x-contentd-csrf': token }), token)).toContain(
      'origin',
    )
  })

  it('rejects a missing or stale token', () => {
    const headers = {
      host: '127.0.0.1:8787',
      origin: 'http://127.0.0.1:8787',
      'sec-fetch-site': 'same-origin',
    }
    expect(csrfFailure(req(headers), token)).toContain('token')
    expect(csrfFailure(req({ ...headers, 'x-contentd-csrf': 'old' }), token)).toContain('token')
  })

  it('rejects an unparseable Origin', () => {
    expect(
      csrfFailure(
        req({ host: '127.0.0.1:8787', origin: 'not a url', 'x-contentd-csrf': token }),
        token,
      ),
    ).toContain('origin')
  })

  it('rejects a same-site (but not same-origin) Sec-Fetch-Site', () => {
    // same-site covers sibling subdomains — a future well-meaning relaxation
    // ("same-site is basically the same thing") would reopen the attack this
    // header exists to close. Only same-origin may pass.
    expect(
      csrfFailure(
        req({
          host: '127.0.0.1:8787',
          origin: 'http://127.0.0.1:8787',
          'sec-fetch-site': 'same-site',
          'x-contentd-csrf': token,
        }),
        token,
      ),
    ).toContain('same-site')
  })

  it('rejects an opaque Origin: null (the sandboxed-iframe form)', () => {
    expect(
      csrfFailure(req({ host: '127.0.0.1:8787', origin: 'null', 'x-contentd-csrf': token }), token),
    ).toContain('origin')
  })

  describe('loopback Host allowlist', () => {
    it('accepts an SSH-port-forward Host whose port differs from the configured one', () => {
      // ssh -L 9999:127.0.0.1:8787 makes the browser send Host: localhost:9999.
      // The allowlist matches on hostname only, so a forwarded port must still
      // pass.
      expect(
        csrfFailure(
          req({
            host: 'localhost:9999',
            origin: 'http://localhost:9999',
            'sec-fetch-site': 'same-origin',
            'x-contentd-csrf': token,
          }),
          token,
        ),
      ).toBeNull()
    })

    it('accepts a bracketed IPv6 loopback Host', () => {
      expect(
        csrfFailure(
          req({
            host: '[::1]:8787',
            origin: 'http://[::1]:8787',
            'sec-fetch-site': 'same-origin',
            'x-contentd-csrf': token,
          }),
          token,
        ),
      ).toBeNull()
    })

    it('rejects a DNS-rebinding request whose Host/Origin agree but are not loopback', () => {
      // The attacker's rebound name satisfies Origin === Host and
      // Sec-Fetch-Site: same-origin (the browser genuinely considers it
      // same-origin to itself once evil.example resolves to 127.0.0.1) and
      // carries the real token lifted from the page it just read. The
      // allowlist is the only layer that still catches it.
      expect(
        csrfFailure(
          req({
            host: 'evil.example:8787',
            origin: 'http://evil.example:8787',
            'sec-fetch-site': 'same-origin',
            'x-contentd-csrf': token,
          }),
          token,
        ),
      ).toContain('loopback')
    })

    it("rejects an empty Host even though it would equal an opaque Origin's empty host", () => {
      // Origin: file:///x parses to host ''. Before the allowlist, an equally
      // empty Host header would satisfy originHost === host and pass the
      // origin layer entirely.
      expect(new URL('file:///x').host).toBe('')
      expect(
        csrfFailure(req({ host: '', origin: 'file:///x', 'x-contentd-csrf': token }), token),
      ).toContain('loopback')
    })
  })
})

describe('mintCsrfToken', () => {
  it('mints a distinct high-entropy token each call', () => {
    const a = mintCsrfToken()
    expect(a).toMatch(/^[0-9a-f]{64}$/)
    expect(a).not.toBe(mintCsrfToken())
  })
})
