import type { LibraryState } from '../../jobs/library.js'
import { html, httpUrlOrNull, SafeHtml } from '../html.js'
import type { LibraryEntry, QcSummary } from '../queries/library.js'
import { formatTime, truncationNotice } from './jobs.js'
import { href } from './layout.js'

const LIBRARY_STATES: LibraryState[] = ['ready', 'needs-review', 'published', 'blocked']

function option(value: string, selected: string | undefined): SafeHtml {
  return selected === value
    ? html`<option value="${value}" selected>${value}</option>`
    : html`<option value="${value}">${value}</option>`
}

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

function renderBytes(entry: LibraryEntry): SafeHtml {
  switch (entry.bytes) {
    case 'local':
      return html`<video controls preload="metadata" src="${href(`/library/${entry.jobId}/video`)}"></video>`
    case 'archived':
      return html`<span class="muted">archived to object storage</span>`
    case 'reclaimed':
      return html`<span class="muted">reclaimed — ${formatTime(entry.createdAt)}</span>`
    case 'unstored':
      return html`<span class="muted">not stored — run <code>library backfill-store</code></span>`
  }
}

export function renderLinks(
  links: LibraryEntry['links'],
  emptyMarkup: SafeHtml = html`<span class="muted">—</span>`,
): SafeHtml {
  if (links.length === 0) return emptyMarkup
  return html`<ul class="links">
    ${links.map((l) => {
      const safeUrl = httpUrlOrNull(l.url)
      return safeUrl === null
        ? html`<li><span class="warning" title="blocked unsafe link scheme">${l.platform}</span></li>`
        : html`<li><a href="${safeUrl}" rel="noreferrer noopener" target="_blank">${l.platform} ↗</a></li>`
    })}
  </ul>`
}

export interface LibraryPageData {
  entries: LibraryEntry[]
  /** Total rows matching the filter, before the 200-row cap. Undefined skips the notice. */
  total?: number
  channels: string[]
  filter: { state?: LibraryState; channel?: string }
}

export function renderLibraryPage(data: LibraryPageData): SafeHtml {
  const filters = html`<form class="filters" method="get" action="/library">
    <select name="state">
      <option value="">all states</option>
      ${LIBRARY_STATES.map((state) => option(state, data.filter.state))}
    </select>
    <select name="channel">
      <option value="">all channels</option>
      ${data.channels.map((channel) => option(channel, data.filter.channel))}
    </select>
    <button type="submit">filter</button>
  </form>`

  if (data.entries.length === 0) {
    return html`<h1>library</h1>
      ${filters}
      <p class="empty">no library entries match these filters</p>`
  }

  const rows = data.entries.map(
    (entry) => html`<tr>
      <td>${renderBytes(entry)}</td>
      <td>
        <a href="${href(`/jobs/${entry.jobId}`)}">${entry.jobId}</a>
        <div class="muted">${entry.channel}</div>
      </td>
      <td>${entry.topic}</td>
      <td class="status-${entry.state}">${entry.state}</td>
      <td>${renderLinks(entry.links)}</td>
      <td>${renderQc(entry.qc)}</td>
      <td>${formatTime(entry.createdAt)}</td>
    </tr>`,
  )

  return html`<h1>library</h1>
    ${filters}
    ${truncationNotice(data.entries.length, data.total)}
    <table>
      <thead>
        <tr><th>video</th><th>job</th><th>topic</th><th>state</th><th>live</th><th>qc</th><th>created</th></tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>`
}
