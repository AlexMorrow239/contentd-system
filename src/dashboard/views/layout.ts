import { html, SafeHtml } from '../html.js'

export type NavKey = 'overview' | 'jobs' | 'library' | 'publishes' | 'topics' | 'actions'

const NAV: { key: NavKey; label: string; path: string }[] = [
  { key: 'overview', label: 'overview', path: '/' },
  { key: 'jobs', label: 'jobs', path: '/jobs' },
  { key: 'library', label: 'library', path: '/library' },
  { key: 'publishes', label: 'publishes', path: '/publishes' },
  { key: 'topics', label: 'topics', path: '/topics' },
]

/**
 * Build a URL carrying the current filter selection.
 *
 * Built by hand rather than with URLSearchParams: that class serializes as
 * application/x-www-form-urlencoded, which encodes a space as '+' rather than
 * '%20'. Do not "simplify" this back to URLSearchParams — layout.test.ts's
 * encoding case is what catches it.
 *
 * It used to also carry the ?db=prod|dev selection; the dashboard serves one
 * root now, so filters are all that is left.
 */
export function href(path: string, extra: Record<string, string> = {}): string {
  const parts: string[] = []
  for (const [key, value] of Object.entries(extra)) {
    if (value !== '') parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
  }
  const query = parts.join('&')
  return query === '' ? path : `${path}?${query}`
}

export interface LayoutOptions {
  title: string
  activeNav: NavKey
  body: SafeHtml
  /** Printed in the footer: which state directory this process reads. */
  root: string
  /** Overview only. Absent means no auto-refresh. */
  refreshSeconds?: number
}

export function layout(opts: LayoutOptions): string {
  const nav = NAV.map((item) =>
    item.key === opts.activeNav
      ? html`<a class="active" href="${href(item.path)}">${item.label}</a>`
      : html`<a href="${href(item.path)}">${item.label}</a>`,
  )

  const refresh =
    opts.refreshSeconds === undefined
      ? html``
      : html`<meta http-equiv="refresh" content="${String(opts.refreshSeconds)}">`

  return `<!doctype html>
${
  html`<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${refresh}
<title>${opts.title} · brainrot</title>
<link rel="stylesheet" href="/static/dashboard.css">
</head>
<body>
<header>
<nav>${nav}</nav>
</header>
<main>${opts.body}</main>
<footer>root=${opts.root} · times shown in container-local time (TZ=${process.env.TZ ?? 'system'})</footer>
</body>
</html>`.value
}`
}
