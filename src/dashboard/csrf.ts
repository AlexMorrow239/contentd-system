import { randomBytes, timingSafeEqual } from 'node:crypto'

/**
 * The dashboard has no authentication and is bound to loopback, which was
 * sufficient while every route was a GET. A POST changes that: CORS blocks a
 * cross-origin page from READING our response, but never from SUBMITTING a
 * form to us. Any tab the operator has open could otherwise reject every
 * topic or trigger a render.
 *
 * Two independent layers, either of which alone would stop the classic attack:
 *   1. the request must prove same-origin through Sec-Fetch-Site/Origin;
 *   2. it must carry the token this process minted at boot.
 *
 * A restart invalidates forms on already-open pages — they get a 403 telling
 * them to reload, which is the right trade for a single-operator tool against
 * cookie/session plumbing in a process that deliberately holds no credentials.
 */

const CSRF_HEADER = 'x-brainrot-csrf'
/** The hidden form field. Read into the header by the POST route. */
export const CSRF_FIELD = 'csrf'

export function mintCsrfToken(): string {
  return randomBytes(32).toString('hex')
}

function tokensMatch(a: string, b: string): boolean {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  // timingSafeEqual throws on a length mismatch, so guard it first; the length
  // itself is not a secret.
  return left.length === right.length && timingSafeEqual(left, right)
}

/**
 * Returns a human-readable rejection reason, or null when the request may
 * proceed. Reason strings are shown to the operator, so they name the failing
 * layer rather than saying "forbidden".
 */
export function csrfFailure(
  req: { header: (name: string) => string | undefined },
  expected: string,
): string | null {
  const fetchSite = req.header('sec-fetch-site')
  if (fetchSite !== undefined && fetchSite !== 'same-origin') {
    return `refused a ${fetchSite} request — actions may only be submitted from the dashboard itself`
  }

  const origin = req.header('origin')
  const host = req.header('host')
  if (origin === undefined || host === undefined) {
    // Also the curl case: no Origin header at all. Deliberate — the CLI is the
    // scripting surface, not this.
    return 'refused a request with no origin — actions may only be submitted from the dashboard itself'
  }
  let originHost: string
  try {
    originHost = new URL(origin).host
  } catch {
    return 'refused a request with an unparseable origin header'
  }
  if (originHost !== host) {
    return `refused a request whose origin (${originHost}) is not this dashboard`
  }

  const token = req.header(CSRF_HEADER)
  if (token === undefined || !tokensMatch(token, expected)) {
    return 'stale or missing form token — reload the page and try again'
  }
  return null
}
