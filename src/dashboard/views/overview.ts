import { html, SafeHtml } from '../html.js'
import type { OverviewData, SpendAgainstCap, StatusCount } from '../queries/overview.js'
import { formatTime, formatUsd } from './jobs.js'
import { href } from './layout.js'
import { actionForm, daemonBanner } from './actions.js'

function countList(counts: StatusCount[]): SafeHtml {
  if (counts.length === 0) return html`<p class="empty">none</p>`
  return html`<table>
    <tbody>
      ${counts.map(
        (entry) => html`<tr>
          <th class="status-${entry.status}">${entry.status}</th>
          <td>${String(entry.count)}</td>
        </tr>`,
      )}
    </tbody>
  </table>`
}

function spendLine(label: string, spend: SpendAgainstCap): SafeHtml {
  const over = spend.spentUsdMicros > spend.capUsdMicros
  const marker = over ? html` <span class="error">over cap</span>` : html``
  return html`<tr>
    <th>${label}</th>
    <td class="${over ? 'status-failed' : ''}">
      ${formatUsd(spend.spentUsdMicros)} / ${formatUsd(spend.capUsdMicros)}${marker}
    </td>
  </tr>`
}

function unattributedSpendLine(usdMicros: number): SafeHtml {
  if (usdMicros <= 0) return html``
  return html`<tr>
    <th>unattributed</th>
    <td class="muted">
      ${formatUsd(usdMicros)} — scout spend and any channel with no current TOML
    </td>
  </tr>`
}

export interface OverviewPageOptions {
  csrfToken: string
  daemonStale: boolean
}

export function renderOverviewPage(
  data: OverviewData,
  configError: string | undefined,
  opts: OverviewPageOptions,
): SafeHtml {
  const warning =
    configError === undefined
      ? html``
      : html`<p class="warning">channel config error: ${configError}</p>`

  const controls = html`<div class="page-actions">
    ${actionForm({
      kind: 'digest.run',
      csrfToken: opts.csrfToken,
      from: '/',
      fields: {},
      disabled: opts.daemonStale,
    })}
  </div>`

  const attention =
    data.attention.length === 0
      ? html`<p class="empty">nothing failed or blocked</p>`
      : html`<table>
          <thead>
            <tr><th>job</th><th>channel</th><th>topic</th><th>status</th><th>stage</th></tr>
          </thead>
          <tbody>
            ${data.attention.map(
              (job) => html`<tr>
                <td><a href="${href(`/jobs/${job.id}`)}">${job.id}</a></td>
                <td>${job.channel}</td>
                <td>${job.topic}</td>
                <td class="status-${job.status}">
                  ${job.status}
                  ${
                    job.status === 'blocked'
                      ? html`<div class="muted">budget enforcement, not a crash</div>`
                      : html``
                  }
                </td>
                <td>
                  ${job.stage ?? html`<span class="muted">—</span>`}
                  ${job.error === null ? html`` : html`<p class="error">${job.error}</p>`}
                </td>
              </tr>`,
            )}
          </tbody>
        </table>`

  const leases =
    data.leases.length === 0
      ? html`<p class="empty">no leases held</p>`
      : html`<table>
          <thead><tr><th>lease</th><th>holder</th><th>expires</th></tr></thead>
          <tbody>
            ${data.leases.map(
              (lease) => html`<tr>
                <td>${lease.name}</td>
                <td>${lease.holder}</td>
                <td class="${lease.expired ? 'status-failed' : ''}">
                  ${formatTime(lease.expiresAt)}${
                    lease.expired ? html` <span class="error">expired</span>` : html``
                  }
                </td>
              </tr>`,
            )}
          </tbody>
        </table>`

  return html`${daemonBanner(opts.daemonStale)}
    <h1>overview</h1>
    ${warning}
    ${controls}
    <div class="grid">
      <div class="panel">
        <h2>jobs</h2>
        ${countList(data.jobsByStatus)}
        <p class="muted">${String(data.jobsLast24h)} created in the last 24h</p>
      </div>
      <div class="panel">
        <h2>library</h2>
        ${countList(data.libraryByState)}
      </div>
      <div class="panel">
        <h2>today's spend (UTC day)</h2>
        <table>
          <tbody>
            ${spendLine('global', data.globalSpend)}
            ${data.channelSpend.map((entry) => spendLine(entry.channel, entry))}
            ${unattributedSpendLine(data.unattributedUsdMicros)}
          </tbody>
        </table>
      </div>
    </div>
    <div class="panel">
      <h2>needs attention</h2>
      ${attention}
    </div>
    <div class="panel">
      <h2>leases</h2>
      ${leases}
    </div>`
}
