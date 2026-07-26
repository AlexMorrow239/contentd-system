import type { DbChoice } from '../config.js'
import { html, SafeHtml } from '../html.js'
import type { PublishRow } from '../../publish/publishes.js'
import type { ChannelGrid } from '../queries/publishes.js'
import { cellKey } from '../queries/publishes.js'
import { dbHref } from './layout.js'

export interface PublishesPageData {
  grids: ChannelGrid[]
  days: number
  quotaUsed: number
  quotaCap: number
  dbChoice: DbChoice
  configError?: string
}

function renderCell(row: PublishRow | undefined, dbChoice: DbChoice): SafeHtml {
  if (row === undefined) return html`<td class="slot-empty">·</td>`

  const link =
    row.url === null
      ? html`<a href="${dbHref(`/jobs/${row.jobId}`, dbChoice)}">${row.status}</a>`
      : html`<a href="${row.url}" rel="noreferrer">${row.status}</a>`

  const kind = row.errorKind === null ? html`` : html`<div class="error">${row.errorKind}</div>`
  const attempt = row.attempt > 1 ? html`<div class="muted">attempt ${row.attempt}</div>` : html``

  return html`<td class="status-${row.status}">${link}${kind}${attempt}</td>`
}

function renderGrid(grid: ChannelGrid, dbChoice: DbChoice): SafeHtml {
  const header = grid.days.map((day) => html`<th>${day}</th>`)
  const rows = grid.slots.map(
    (slot) => html`<tr>
      <th>${slot}</th>
      ${grid.days.map((day) => renderCell(grid.cells.get(cellKey(day, slot)), dbChoice))}
    </tr>`,
  )
  return html`<div class="panel">
    <h2>${grid.channel}</h2>
    <table class="slot-grid">
      <thead>
        <tr><th>slot</th>${header}</tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  </div>`
}

export function renderPublishesPage(data: PublishesPageData): SafeHtml {
  const warning =
    data.configError === undefined
      ? html``
      : html`<p class="warning">channel config error: ${data.configError}</p>`

  const quota = html`<div class="panel">
    <h2>youtube daily quota</h2>
    <p>${String(data.quotaUsed)} / ${String(data.quotaCap)} uploads used today (all channels)</p>
  </div>`

  if (data.grids.length === 0) {
    return html`<h1>publishes</h1>
      ${warning} ${quota}
      <p class="empty">no channel has a [publish] schedule</p>`
  }

  return html`<h1>publishes · last ${String(data.days)} days</h1>
    ${warning} ${quota}
    ${data.grids.map((grid) => renderGrid(grid, data.dbChoice))}`
}
