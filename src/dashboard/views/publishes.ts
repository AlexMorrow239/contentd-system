import type { DbChoice } from '../config.js'
import { html, httpUrlOrNull, SafeHtml } from '../html.js'
import type { PublishRow } from '../../publish/publishes.js'
import type { Platform } from '../../publish/types.js'
import type { ChannelGrid } from '../queries/publishes.js'
import { cellKey } from '../queries/publishes.js'
import { dbHref } from './layout.js'

// One platform's quota, shaped for display rather than for the enforcement
// check itself (PlatformQuota in publish/types.ts). A 'global' quota
// (YouTube) is a single all-channels figure, matching adapter.quota.scope —
// see that type's comment for why: one Google Cloud project's upload quota
// is shared across every channel. A 'channel' quota (Instagram) has no
// single "used" figure to report — each channel's IG account is capped
// independently against the same per-channel `cap` — so it carries a
// per-channel breakdown instead. An empty perChannel array (rather than
// omitting the platform) is what lets the panel say so explicitly instead of
// silently having nothing to show.
// A union rather than one shape with two optional fields: which figure exists
// is fully determined by the quota's scope, so the type says so and the
// renderer needs no defensive fallback for a combination that cannot occur.
export type PlatformQuotaView =
  | { platform: Platform; scope: 'global'; cap: number; used: number }
  | {
      platform: Platform
      scope: 'channel'
      cap: number
      /** One entry per channel with this platform configured. */
      perChannel: { channel: string; used: number }[]
    }

export interface PublishesPageData {
  grids: ChannelGrid[]
  days: number
  quotas: PlatformQuotaView[]
  dbChoice: DbChoice
  configError?: string
}

function renderCell(row: PublishRow | undefined, dbChoice: DbChoice): SafeHtml {
  if (row === undefined) return html`<td class="slot-empty">·</td>`

  // Not currently exploitable — url is constructed server-side with a fixed
  // https:// scheme, never from user input — but routed through the same
  // check as topics.ts so the hardening cannot be quietly lost later.
  const safeUrl = row.url === null ? null : httpUrlOrNull(row.url)
  const link =
    safeUrl === null
      ? html`<a href="${dbHref(`/jobs/${row.jobId}`, dbChoice)}">${row.status}</a>`
      : html`<a href="${safeUrl}" rel="noreferrer">${row.status}</a>`

  const kind = row.errorKind === null ? html`` : html`<div class="error">${row.errorKind}</div>`
  const attempt = row.attempt > 1 ? html`<div class="muted">attempt ${row.attempt}</div>` : html``

  return html`<td class="status-${row.status}">${link}${kind}${attempt}</td>`
}

function renderGrid(grid: ChannelGrid, dbChoice: DbChoice): SafeHtml {
  const header = grid.days.map((day) => html`<th>${day}</th>`)
  const rows = grid.rows.map(
    (row) => html`<tr>
      <th>${row.slot} ${row.platform}</th>
      ${grid.days.map((day) =>
        renderCell(grid.cells.get(cellKey(day, row.slot, row.platform)), dbChoice),
      )}
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

function renderQuota(q: PlatformQuotaView): SafeHtml {
  if (q.scope === 'global') {
    return html`<p>
      ${q.platform}: ${String(q.used)} / ${String(q.cap)} uploads used today (all channels)
    </p>`
  }
  if (q.perChannel.length === 0) {
    return html`<p>${q.platform}: no channel has a [publish.${q.platform}] target configured</p>`
  }
  const rows = q.perChannel.map(
    (c) => html`<li>${c.channel}: ${String(c.used)} / ${String(q.cap)}</li>`,
  )
  return html`<div>
    <p>${q.platform} (per channel, ${String(q.cap)}/day each):</p>
    <ul>
      ${rows}
    </ul>
  </div>`
}

export function renderPublishesPage(data: PublishesPageData): SafeHtml {
  const warning =
    data.configError === undefined
      ? html``
      : html`<p class="warning">channel config error: ${data.configError}</p>`

  const quota = html`<div class="panel">
    <h2>daily upload quotas</h2>
    ${data.quotas.map(renderQuota)}
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
