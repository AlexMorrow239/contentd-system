/**
 * Marker for a string that is already valid, trusted HTML. The `html`
 * template escapes everything it interpolates EXCEPT instances of this class,
 * which is what lets views nest each other without double-escaping.
 */
export class SafeHtml {
  constructor(readonly value: string) {}
  toString(): string {
    return this.value
  }
}

export function raw(value: string): SafeHtml {
  return new SafeHtml(value)
}

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
}

// Quotes are escaped alongside the angle brackets so the same helper is safe
// inside an attribute value, not only in element content.
export function escapeHtml(value: unknown): string {
  return String(value).replace(/[&<>"']/g, (ch) => ESCAPES[ch])
}

/**
 * Returns `raw` if (and only if) it is a well-formed absolute `http:`/`https:`
 * URL, otherwise `null`. Use this before placing scraped/untrusted input into
 * an `href` attribute: `escapeHtml` keeps the attribute delimiter safe but
 * says nothing about the scheme, so a stored `javascript:` (or `data:`,
 * `vbscript:`, scheme-relative `//host`, etc.) value would otherwise become a
 * clickable link that executes in the dashboard's own origin.
 *
 * Browsers strip leading/trailing whitespace and embedded tab/newline
 * characters from a URL before dispatching a click, so `"  \n\tjavascript:..."`
 * would read as safe to a naive prefix check while still running as script.
 * We strip the same characters before parsing so the check sees what the
 * browser would actually navigate to. Parsing (rather than pattern-matching)
 * via the `URL` constructor also means we don't need to special-case
 * mixed-case schemes, since `URL#protocol` is always lowercased.
 */
export function httpUrlOrNull(input: string): string | null {
  // Mirror the whitespace/control-character stripping browsers do when
  // parsing a URL from an href before navigation, so this check can't be
  // bypassed by hiding the scheme behind characters that get discarded later.
  const stripped = input.replace(/[\t\n\r]+/g, '').trim()
  let parsed: URL
  try {
    parsed = new URL(stripped)
  } catch {
    return null
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
  return input
}

function render(value: unknown): string {
  if (value instanceof SafeHtml) return value.value
  if (Array.isArray(value)) return value.map(render).join('')
  if (value === null || value === undefined) return ''
  return escapeHtml(value)
}

/**
 * Escape-by-default HTML template. Anything interpolated is escaped unless it
 * is SafeHtml (from another `html` call or from `raw`). Opting IN to raw
 * output is a visible three-character call; opting out of escaping by
 * accident is impossible.
 */
export function html(strings: TemplateStringsArray, ...values: unknown[]): SafeHtml {
  let out = strings[0]
  for (let i = 0; i < values.length; i++) {
    out += render(values[i]) + strings[i + 1]
  }
  return new SafeHtml(out)
}
