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
          'x-brainrot-csrf': token,
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
          'x-brainrot-csrf': token,
        }),
        token,
      ),
    ).toContain('cross-site')
  })

  it('rejects an Origin whose host is not our own', () => {
    expect(
      csrfFailure(
        req({ host: '127.0.0.1:8787', origin: 'http://evil.example', 'x-brainrot-csrf': token }),
        token,
      ),
    ).toContain('origin')
  })

  it('rejects a request with neither Origin nor Sec-Fetch-Site', () => {
    // curl sends neither. Scripting is what the CLI is for.
    expect(csrfFailure(req({ host: '127.0.0.1:8787', 'x-brainrot-csrf': token }), token)).toContain(
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
    expect(csrfFailure(req({ ...headers, 'x-brainrot-csrf': 'old' }), token)).toContain('token')
  })

  it('rejects an unparseable Origin', () => {
    expect(
      csrfFailure(
        req({ host: '127.0.0.1:8787', origin: 'not a url', 'x-brainrot-csrf': token }),
        token,
      ),
    ).toContain('origin')
  })
})

describe('mintCsrfToken', () => {
  it('mints a distinct high-entropy token each call', () => {
    const a = mintCsrfToken()
    expect(a).toMatch(/^[0-9a-f]{64}$/)
    expect(a).not.toBe(mintCsrfToken())
  })
})
