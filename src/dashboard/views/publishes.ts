import { html, httpUrlOrNull, SafeHtml } from '../html.js'
import type { PublishRow } from '../../publish/publishes.js'
import type { Platform } from '../../publish/types.js'
import type { ChannelGrid, InterruptedPublish } from '../queries/publishes.js'
import { cellKey } from '../queries/publishes.js'
import { href } from './layout.js'
import { actionForm, daemonBanner } from './actions.js'

// One platform's quota, shaped for display rather than for the enforcement
// check itself (PlatformQuota in publish/types.ts). A 'global' quota
// (YouTube) is a single all-channels figure, matching adapter.quota.scope —
// see that type's comment for why: one Google Cloud project's upload quota
// is shared across every channel. A 'channel' quota (Instagram) has no
// single "used" figure to report — each channel's IG account is rate-limited
// independently — so it carries a per-channel breakdown instead. An empty
// perChannel array (rather than omitting the platform) is what lets the
// panel say so explicitly instead of silently having nothing to show.
// There is no local cap anymore: `used` is today's count and `backedOff`
// reports quotaBackedOff (src/publish/publishes.ts) — the platform's own
// runtime signal, read here via a SELECT only, keeping the dashboard
// structurally read-only.
// A union rather than one shape with two optional fields: which figure exists
// is fully determined by the quota's scope, so the type says so and the
// renderer needs no defensive fallback for a combination that cannot occur.
export type PlatformQuotaView =
  | { platform: Platform; scope: 'global'; used: number; backedOff: boolean }
  | {
      platform: Platform
      scope: 'channel'
      /** One entry per channel with this platform configured. */
      perChannel: { channel: string; used: number; backedOff: boolean }[]
    }

export interface PublishesPageData {
  grids: ChannelGrid[]
  days: number
  quotas: PlatformQuotaView[]
  interrupted: InterruptedPublish[]
  csrfToken: string
  daemonStale: boolean
  configError?: string
}

function interruptedSection(
  rows: InterruptedPublish[],
  csrfToken: string,
  daemonStale: boolean,
): SafeHtml {
  if (rows.length === 0) return html``
  const items = rows.map(
    (row) => html`<tr>
      <td><a href="${href(`/jobs/${row.jobId}`)}">${row.jobId}</a></td>
      <td>${row.channel}</td>
      <td>${row.platform}</td>
      <td>${row.createdAt}</td>
      <td>
        ${actionForm({
          kind: 'publish.retry',
          csrfToken,
          from: '/publishes',
          fields: { jobId: row.jobId },
          disabled: daemonStale,
        })}
        ${actionForm({
          kind: 'publish.markDone',
          csrfToken,
          from: '/publishes',
          fields: { jobId: row.jobId },
          disabled: daemonStale,
        })}
      </td>
    </tr>`,
  )
  return html`<section class="interrupted">
    <h2>interrupted uploads</h2>
    <p class="muted">
      The daemon could not confirm these landed. Check the platform, then clear them for another
      attempt or record the post id.
    </p>
    <table><thead><tr><th>job</th><th>channel</th><th>platform</th><th>when</th><th></th></tr></thead>
    <tbody>${items}</tbody></table>
  </section>`
}

function renderCell(row: PublishRow | undefined): SafeHtml {
  if (row === undefined) return html`<td class="cell-empty">·</td>`

  // Not currently exploitable — url is constructed server-side with a fixed
  // https:// scheme, never from user input — but routed through the same
  // check as topics.ts so the hardening cannot be quietly lost later.
  const safeUrl = row.url === null ? null : httpUrlOrNull(row.url)
  const link =
    safeUrl === null
      ? html`<a href="${href(`/jobs/${row.jobId}`)}">${row.status}</a>`
      : html`<a href="${safeUrl}" rel="noreferrer">${row.status}</a>`

  const kind = row.errorKind === null ? html`` : html`<div class="error">${row.errorKind}</div>`
  const attempt = row.attempt > 1 ? html`<div class="muted">attempt ${row.attempt}</div>` : html``

  return html`<td class="status-${row.status}">${link}${kind}${attempt}</td>`
}

function renderGrid(grid: ChannelGrid): SafeHtml {
  const header = grid.days.map((day) => html`<th>${day}</th>`)
  const rows = grid.rows.map(
    (row) => html`<tr>
      <th>#${String(row.seq)} ${row.platform}</th>
      ${grid.days.map((day) => renderCell(grid.cells.get(cellKey(day, row.seq, row.platform))))}
    </tr>`,
  )
  return html`<div class="panel">
    <h2>${grid.channel}</h2>
    <table class="publish-grid">
      <thead>
        <tr><th>#</th>${header}</tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  </div>`
}

function backedOffBadge(backedOff: boolean): SafeHtml {
  return backedOff ? html` <span class="error">backed off</span>` : html``
}

function renderQuota(q: PlatformQuotaView): SafeHtml {
  if (q.scope === 'global') {
    return html`<p>
      ${q.platform}: ${String(q.used)} uploads used today (all channels)${backedOffBadge(q.backedOff)}
    </p>`
  }
  if (q.perChannel.length === 0) {
    return html`<p>${q.platform}: no channel has a [publish.${q.platform}] target configured</p>`
  }
  const rows = q.perChannel.map(
    (c) =>
      html`<li>${c.channel}: ${String(c.used)} uploads used today${backedOffBadge(c.backedOff)}</li>`,
  )
  return html`<div>
    <p>${q.platform} (per channel):</p>
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

  const interrupted = interruptedSection(data.interrupted, data.csrfToken, data.daemonStale)

  if (data.grids.length === 0) {
    return html`${daemonBanner(data.daemonStale)}
      <h1>publishes</h1>
      ${warning} ${interrupted} ${quota}
      <p class="empty">no channel has a [publish] schedule</p>`
  }

  return html`${daemonBanner(data.daemonStale)}
    <h1>publishes · last ${String(data.days)} days</h1>
    ${warning} ${interrupted} ${quota}
    ${data.grids.map((grid) => renderGrid(grid))}`
}
