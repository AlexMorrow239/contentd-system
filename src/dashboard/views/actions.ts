import { ACTIONS, type ActionKind } from '../../actions/catalog.js'
import type { ActionRow } from '../../actions/queue.js'
import type { ActionsPageData } from '../queries/actions.js'
import { html, SafeHtml } from '../html.js'
import { href } from './layout.js'

export interface ActionFormOptions {
  kind: ActionKind
  csrfToken: string
  /** Absolute same-site path the 303 returns to. */
  from: string
  /** Hidden arg fields, already stringified. */
  fields: Record<string, string>
  label?: string
  disabled?: boolean
  /** Renders as a link-styled control rather than a button. */
  subtle?: boolean
}

/**
 * The one control every mutating page uses. Zero JavaScript: a plain form
 * POST, or — for a confirm:true action — a GET link to the interstitial, which
 * both explains the consequence and collects any free-text argument.
 */
export function actionForm(opts: ActionFormOptions): SafeHtml {
  const label = opts.label ?? ACTIONS[opts.kind].label
  const cls = opts.subtle === true ? 'action-link' : 'action-button'

  if (ACTIONS[opts.kind].confirm) {
    if (opts.disabled === true) {
      // Not an <a>: a disabled anchor is still focusable and navigable in
      // most browsers, which would carry the operator to the confirm page
      // for a stale daemon anyway. A non-navigable span reads as disabled
      // and cannot be clicked through.
      return html`<span class="${cls}" aria-disabled="true">${label}…</span>`
    }
    const query: Record<string, string> = { kind: opts.kind, from: opts.from, ...opts.fields }
    return html`<a class="${cls}" href="${href('/actions/confirm', query)}">${label}…</a>`
  }

  const hidden = Object.entries(opts.fields).map(
    ([name, value]) => html`<input type="hidden" name="${name}" value="${value}">`,
  )
  return html`<form class="action" method="post" action="/actions">
    <input type="hidden" name="kind" value="${opts.kind}">
    <input type="hidden" name="csrf" value="${opts.csrfToken}">
    <input type="hidden" name="from" value="${opts.from}">
    ${hidden}
    <button class="${cls}" type="submit" ${opts.disabled === true ? new SafeHtml('disabled') : ''}>
      ${label}
    </button>
  </form>`
}

/**
 * The toolbar every page uses for its non-row controls. A plain wrapper so the
 * three pages agree on placement and spacing without each re-deriving it.
 */
export function pageActions(controls: SafeHtml[]): SafeHtml {
  return html`<div class="page-actions">${controls}</div>`
}

export function daemonBanner(stale: boolean): SafeHtml {
  if (!stale) return html``
  return html`<p class="banner error">
    daemon not running — queued actions will not execute until it is back up.
  </p>`
}

export function missingTableBanner(): SafeHtml {
  return html`<p class="banner error">
    this database has no action queue yet — start the daemon once against this root to initialize
    the schema.
  </p>`
}

/**
 * The zero-JS confirmation step for a confirm:true action. It carries two
 * jobs at once: it states the consequence in words before anything
 * irreversible happens, and it collects any argument the calling page could
 * not supply (publish.markDone's postId, which the operator reads off the
 * platform).
 */
export function renderConfirmPage(opts: {
  kind: ActionKind
  csrfToken: string
  from: string
  fields: Record<string, string>
  missing: string[]
  daemonStale: boolean
}): SafeHtml {
  const desc = ACTIONS[opts.kind]
  const hidden = Object.entries(opts.fields).map(
    ([name, value]) => html`<input type="hidden" name="${name}" value="${value}">`,
  )
  const inputs = opts.missing.map(
    (name) => html`<label class="field">${name}
      <input type="text" name="${name}" required autocomplete="off">
    </label>`,
  )
  const known = Object.entries(opts.fields).map(
    ([name, value]) => html`<li><span class="muted">${name}</span> <code>${value}</code></li>`,
  )

  return html`${daemonBanner(opts.daemonStale)}
    <h1>confirm: ${desc.label}</h1>
    <p class="danger">${desc.danger ?? 'This action cannot be undone.'}</p>
    <ul class="args">${known}</ul>
    <form method="post" action="/actions">
      <input type="hidden" name="kind" value="${opts.kind}">
      <input type="hidden" name="csrf" value="${opts.csrfToken}">
      <input type="hidden" name="from" value="${opts.from}">
      ${hidden} ${inputs}
      <button
        class="action-button danger"
        type="submit"
        ${opts.daemonStale ? new SafeHtml('disabled') : ''}
      >${desc.label}</button>
      <a class="action-link" href="${opts.from === '' ? '/actions' : opts.from}">cancel</a>
    </form>`
}

export function renderActionsPage(
  data: ActionsPageData,
  opts: { highlightId?: number },
): SafeHtml {
  const rows = data.actions.map((row) => renderRow(row, opts.highlightId))
  const body =
    data.actions.length === 0
      ? html`<p class="muted">no operator actions yet.</p>`
      : html`<div class="actions-list">${rows}</div>`

  return html`${daemonBanner(data.daemonStale)}
    <h1>actions</h1>
    <p class="muted">
      Every operator action queued from this dashboard, newest first. Actions execute inside the
      daemon under the same leases its workers take, so they never race a live render or upload.
    </p>
    ${body}`
}

function renderRow(row: ActionRow, highlightId: number | undefined): SafeHtml {
  const cls = row.id === highlightId ? 'row highlight' : 'row'
  const detail =
    row.status === 'failed'
      ? html`<span class="error">${row.error} <span class="muted">(${row.errorKind})</span></span>`
      : row.notice !== null
        ? html`<span class="notice">${row.notice}</span>`
        : row.result !== null
          ? html`<code>${row.result}</code>`
          : html``

  return html`<div class="${cls}">
    <span class="status status-${row.status}">${row.status}</span>
    <span class="kind">${row.kind}</span>
    <span class="muted">${row.lane}</span>
    <code class="args">${row.args}</code>
    <span class="when muted">${row.createdAt}</span>
    <div class="detail">${detail}</div>
  </div>`
}
