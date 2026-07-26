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
