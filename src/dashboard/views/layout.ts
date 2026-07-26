import type { DbChoice } from '../config.js'
import { html, SafeHtml } from '../html.js'

export type NavKey = 'overview' | 'jobs' | 'library' | 'publishes' | 'topics'

const NAV: { key: NavKey; label: string; path: string }[] = [
  { key: 'overview', label: 'overview', path: '/' },
  { key: 'jobs', label: 'jobs', path: '/jobs' },
  { key: 'library', label: 'library', path: '/library' },
  { key: 'publishes', label: 'publishes', path: '/publishes' },
  { key: 'topics', label: 'topics', path: '/topics' },
]

/**
 * Build a URL that carries the current database selection. prod is the
 * default, so it is expressed by the ABSENCE of ?db= — that keeps ordinary
 * URLs clean and makes a dev link visibly different in the address bar.
 *
 * Built by hand rather than with URLSearchParams: that class serializes as
 * application/x-www-form-urlencoded, which encodes a space as '+' rather than
 * '%20'. Do not "simplify" this back to URLSearchParams — layout.test.ts's
 * encoding case is what catches it.
 */
export function dbHref(
  path: string,
  dbChoice: DbChoice,
  extra: Record<string, string> = {},
): string {
  const parts: string[] = []
  if (dbChoice === 'dev') parts.push('db=dev')
  for (const [key, value] of Object.entries(extra)) {
    if (value !== '') parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
  }
  const query = parts.join('&')
  return query === '' ? path : `${path}?${query}`
}

export interface LayoutOptions {
  title: string
  dbChoice: DbChoice
  activeNav: NavKey
  body: SafeHtml
  /** Overview only. Absent means no auto-refresh. */
  refreshSeconds?: number
}

export function layout(opts: LayoutOptions): string {
  const nav = NAV.map((item) =>
    item.key === opts.activeNav
      ? html`<a class="active" href="${dbHref(item.path, opts.dbChoice)}">${item.label}</a>`
      : html`<a href="${dbHref(item.path, opts.dbChoice)}">${item.label}</a>`,
  )

  // The switcher points at the CURRENT page on the other database, so
  // flipping prod/dev keeps you where you are instead of bouncing home.
  const otherChoice: DbChoice = opts.dbChoice === 'dev' ? 'prod' : 'dev'
  const activePath = NAV.find((item) => item.key === opts.activeNav)?.path ?? '/'

  const refresh =
    opts.refreshSeconds === undefined
      ? html``
      : html`<meta http-equiv="refresh" content="${String(opts.refreshSeconds)}">`

  const banner =
    opts.dbChoice === 'dev'
      ? html`<div class="env-banner dev">development database — not production</div>`
      : html``

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
<body class="${opts.dbChoice}">
${banner}
<header>
<nav>${nav}</nav>
<a class="db-switch" href="${dbHref(activePath, otherChoice)}">viewing ${opts.dbChoice} · switch to ${otherChoice}</a>
</header>
<main>${opts.body}</main>
<footer>times shown in container-local time (TZ=${process.env.TZ ?? 'system'})</footer>
</body>
</html>`.value
}`
}
