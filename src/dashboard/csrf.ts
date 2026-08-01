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

// Hostnames only — deliberately NOT host:port. The sanctioned remote-access
// path for this dashboard is an SSH port-forward to loopback on both ends
// (`ssh -L 9999:127.0.0.1:8787`), which routinely lands on a different local
// port than the dashboard is configured for: the browser sends
// `Host: localhost:9999`. Pinning the configured port would break that path
// while adding nothing — rebinding is defeated by rejecting non-loopback
// *names*, not by the port. `new URL(...).hostname` renders an IPv6 loopback
// as `[::1]` (brackets included), which is why that form is listed literally
// rather than as `::1`.
const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '[::1]'])

/**
 * Parses the Host header's hostname (ignoring any port) via the URL parser,
 * so IPv6 bracket forms and case are handled the same way a browser would
 * rather than by hand-rolled string matching. Returns false for anything
 * unparseable, including an empty string.
 */
function isLoopbackHost(host: string): boolean {
  try {
    return LOOPBACK_HOSTNAMES.has(new URL(`http://${host}`).hostname)
  } catch {
    return false
  }
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

  // The Origin-vs-Host comparison just below proves only that the two headers
  // AGREE with each other — never that the host they agree on is actually
  // ours. That is self-satisfying under DNS rebinding: the operator loads
  // http://evil.example:8787/ while evil.example still resolves to the
  // attacker's server, the attacker then rebinds the name to 127.0.0.1 (short
  // TTL), and a page fetched from that "same" origin is now genuinely
  // same-origin with the dashboard by the browser's own rules — CORS lets it
  // read the dashboard HTML and lift the CSRF token, and its POST carries a
  // matching Host, Origin, Sec-Fetch-Site: same-origin, and the correct
  // token. Every layer below would accept it. Gating on a fixed loopback
  // allowlist first is what a future reader must not "simplify away" as
  // redundant with the comparison beneath it — it is the only check here that
  // asks "is this host ours" rather than "do these two headers match".
  if (!isLoopbackHost(host)) {
    return `refused a request whose Host (${host}) is not a loopback address`
  }

  let originHost: string
  try {
    originHost = new URL(origin).host
  } catch {
    return 'refused a request with an unparseable origin header'
  }
  // Scheme is intentionally not compared: `.host` carries hostname+port only,
  // so `new URL('https://127.0.0.1:8787').host` equals the http form's, and an
  // https Origin against an http Host would pass. Not exploitable — the
  // loopback allowlist above is what actually gates trust, not this
  // agreement check — so it is left as-is rather than re-deriving scheme from
  // Origin to reject a same-host scheme mismatch that buys nothing.
  if (originHost !== host) {
    return `refused a request whose origin (${originHost}) is not this dashboard`
  }

  const token = req.header(CSRF_HEADER)
  if (token === undefined || !tokensMatch(token, expected)) {
    return 'stale or missing form token — reload the page and try again'
  }
  return null
}
