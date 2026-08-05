import { LIBRARY_STATES, type LibraryState } from '../../jobs/library.js'
import { html, safeLink, SafeHtml } from '../html.js'
import type { LibraryEntry, QcSummary } from '../queries/library.js'
import { bytesCell } from './bytes.js'
import { filterForm } from './filters.js'
import { formatTime, truncationNotice } from './jobs.js'
import { href } from './layout.js'
import { actionForm, daemonBanner, pageActions } from './actions.js'

function renderQc(qc: QcSummary): SafeHtml {
  switch (qc.kind) {
    case 'ok':
      return html`<span class="status-done">qc ok</span>`
    case 'issues':
      return html`<ul class="error">
        ${qc.issues.map((issue) => html`<li>${issue}</li>`)}
      </ul>`
    case 'unparseable':
      return html`<span class="warning">unparseable metadata</span>`
    case 'absent':
      return html`<span class="muted">no qc block</span>`
  }
}

export function renderLinks(
  links: LibraryEntry['links'],
  emptyMarkup: SafeHtml = html`<span class="muted">—</span>`,
): SafeHtml {
  if (links.length === 0) return emptyMarkup
  return html`<ul class="links">
    ${links.map((l) => html`<li>${safeLink(l.url, l.platform, { linkSuffix: '↗' })}</li>`)}
  </ul>`
}

export interface LibraryPageData {
  entries: LibraryEntry[]
  /** Total rows matching the filter, before the 200-row cap. Undefined skips the notice. */
  total?: number
  channels: string[]
  filter: { state?: LibraryState; channel?: string }
  csrfToken: string
  daemonStale: boolean
}

function libraryActions(
  row: { jobId: string; state: string },
  csrfToken: string,
  daemonStale: boolean,
): SafeHtml {
  // 'blocked' is already the discard state — nothing left to approve or
  // reject from there.
  if (row.state === 'blocked') return html``
  const approve =
    row.state === 'needs-review'
      ? actionForm({
          kind: 'library.approve',
          csrfToken,
          from: '/library',
          fields: { jobIds: row.jobId },
          disabled: daemonStale,
        })
      : html``
  const reject = actionForm({
    kind: 'library.reject',
    csrfToken,
    from: '/library',
    fields: { jobIds: row.jobId },
    disabled: daemonStale,
    subtle: true,
  })
  return html`${approve} ${reject}`
}

export function renderLibraryPage(data: LibraryPageData): SafeHtml {
  const filters = filterForm('/library', [
    { name: 'state', allLabel: 'all states', values: LIBRARY_STATES, selected: data.filter.state },
    {
      name: 'channel',
      allLabel: 'all channels',
      values: data.channels,
      selected: data.filter.channel,
    },
  ])

  const controls = pageActions([
    actionForm({
      kind: 'library.backfillStore',
      csrfToken: data.csrfToken,
      from: '/library',
      fields: {},
      disabled: data.daemonStale,
    }),
  ])

  if (data.entries.length === 0) {
    return html`${daemonBanner(data.daemonStale)}
      <h1>library</h1>
      ${filters}
      ${controls}
      <p class="empty">no library entries match these filters</p>`
  }

  const rows = data.entries.map(
    (entry) => html`<tr>
      <td>
        ${bytesCell(entry.bytes, entry.jobId, {
          reclaimed: `reclaimed — ${formatTime(entry.createdAt)}`,
        })}
      </td>
      <td>
        <a href="${href(`/jobs/${entry.jobId}`)}">${entry.jobId}</a>
        <div class="muted">${entry.channel}</div>
      </td>
      <td>${entry.topic}</td>
      <td class="status-${entry.state}">${entry.state}</td>
      <td>${renderLinks(entry.links)}</td>
      <td>${renderQc(entry.qc)}</td>
      <td>${formatTime(entry.createdAt)}</td>
      <td>${libraryActions(entry, data.csrfToken, data.daemonStale)}</td>
    </tr>`,
  )

  return html`${daemonBanner(data.daemonStale)}
    <h1>library</h1>
    ${filters}
    ${controls}
    ${truncationNotice(data.entries.length, data.total)}
    <table>
      <thead>
        <tr><th>video</th><th>job</th><th>topic</th><th>state</th><th>live</th><th>qc</th><th>created</th><th></th></tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>`
}
