import { html, SafeHtml } from '../html.js'
import type { JobDetail, JobListRow, JobStatus, StageRow } from '../queries/jobs.js'
import { href } from './layout.js'
import { renderLinks } from './library.js'
import { actionForm, daemonBanner, pageActions } from './actions.js'

export function formatUsd(usdMicros: number): string {
  return `$${(usdMicros / 1_000_000).toFixed(2)}`
}

/** Container-local rendering of a UTC ISO timestamp. */
export function formatTime(iso: string | null): string {
  if (iso === null) return '—'
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString()
}

export function formatDuration(startedAt: string | null, finishedAt: string | null): string {
  if (startedAt === null || finishedAt === null) return '—'
  const ms = new Date(finishedAt).getTime() - new Date(startedAt).getTime()
  if (!Number.isFinite(ms) || ms < 0) return '—'
  if (ms < 1000) return `${ms}ms`
  const seconds = Math.round(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  return `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, '0')}s`
}

const JOB_STATUSES: JobStatus[] = ['queued', 'running', 'failed', 'done', 'blocked']

function option(value: string, selected: string | undefined): SafeHtml {
  return selected === value
    ? html`<option value="${value}" selected>${value}</option>`
    : html`<option value="${value}">${value}</option>`
}

export interface JobsPageData {
  jobs: JobListRow[]
  /** Total rows matching the filter, before the 200-row cap. Undefined skips the notice. */
  total?: number
  channels: string[]
  filter: { channel?: string; status?: JobStatus }
  csrfToken: string
  daemonStale: boolean
}

/**
 * Resume is offered only where `resumeJob` would accept the job: `failed` and
 * `blocked`. A `running` job needs --force, which is CLI-only by design, and
 * `done`/`queued` have nothing to resume.
 */
function jobActions(
  row: { id: string; status: JobStatus },
  csrfToken: string,
  daemonStale: boolean,
): SafeHtml {
  if (row.status !== 'failed' && row.status !== 'blocked') return html``
  return actionForm({
    kind: 'jobs.resume',
    csrfToken,
    from: '/jobs',
    fields: { jobId: row.id },
    disabled: daemonStale,
  })
}

/**
 * "showing 200 of 1,432" when a caller-side cap truncated the list, so the
 * truncation is visible instead of silently dropping rows. Renders nothing
 * when total is unknown or the shown count already equals it.
 */
export function truncationNotice(shown: number, total: number | undefined): SafeHtml {
  if (total === undefined || shown >= total) return html``
  return html`<p class="muted">showing ${shown.toLocaleString()} of ${total.toLocaleString()}</p>`
}

export function renderJobsPage(data: JobsPageData): SafeHtml {
  const filters = html`<form class="filters" method="get" action="/jobs">
    <select name="channel">
      <option value="">all channels</option>
      ${data.channels.map((channel) => option(channel, data.filter.channel))}
    </select>
    <select name="status">
      <option value="">all statuses</option>
      ${JOB_STATUSES.map((status) => option(status, data.filter.status))}
    </select>
    <button type="submit">filter</button>
  </form>`

  const controls = pageActions([
    actionForm({
      kind: 'produce.next',
      csrfToken: data.csrfToken,
      from: '/jobs',
      fields: {},
      disabled: data.daemonStale,
    }),
  ])

  if (data.jobs.length === 0) {
    return html`${daemonBanner(data.daemonStale)}
      <h1>jobs</h1>
      ${controls}
      ${filters}
      <p class="empty">no jobs match these filters</p>`
  }

  const rows = data.jobs.map(
    (job) => html`<tr>
      <td><a href="${href(`/jobs/${job.id}`)}">${job.id}</a></td>
      <td>${job.channel}</td>
      <td>${job.tier}</td>
      <td>${job.topic}</td>
      <td class="status-${job.status}">${job.status}</td>
      <td>${formatTime(job.createdAt)}</td>
      <td>${formatDuration(job.createdAt, job.finishedAt)}</td>
      <td>${formatUsd(job.costUsdMicros)}</td>
      <td>${jobActions(job, data.csrfToken, data.daemonStale)}</td>
    </tr>`,
  )

  return html`${daemonBanner(data.daemonStale)}
    <h1>jobs</h1>
    ${controls}
    ${filters}
    ${truncationNotice(data.jobs.length, data.total)}
    <table>
      <thead>
        <tr>
          <th>id</th><th>channel</th><th>tier</th><th>topic</th>
          <th>status</th><th>created</th><th>elapsed</th><th>cost</th><th></th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>`
}

function stageRow(stage: StageRow): SafeHtml {
  const error = stage.error === null ? html`` : html`<p class="error">${stage.error}</p>`
  return html`<tr>
    <td>${stage.stage}</td>
    <td class="status-${stage.status}">${stage.status}</td>
    <td>${formatDuration(stage.startedAt, stage.finishedAt)}</td>
    <td>${formatTime(stage.startedAt)}${error}</td>
  </tr>`
}

export function renderJobDetailPage(detail: JobDetail, runsRoot: string): SafeHtml {
  const { job } = detail

  const video =
    detail.bytes === null
      ? html``
      : html`<div class="panel">
          <h2>video</h2>
          ${detail.bytes === 'local'
            ? html`<video controls preload="metadata" src="${href(`/library/${job.id}/video`)}"></video>`
            : detail.bytes === 'archived'
              ? html`<p class="muted">archived to object storage — not available locally</p>`
              : detail.bytes === 'reclaimed'
                ? html`<p class="muted">reclaimed — the stored object was deleted after every platform settled</p>`
                : html`<p class="muted">not stored — run <code>library backfill-store</code></p>`}
          ${renderLinks(detail.links, html``)}
        </div>`

  const costs =
    detail.costs.length === 0
      ? html`<p class="empty">no ledgered spend</p>`
      : html`<table>
          <thead><tr><th>provider</th><th>operation</th><th>cost</th><th>at</th></tr></thead>
          <tbody>
            ${detail.costs.map(
              (cost) => html`<tr>
                <td>${cost.provider}</td>
                <td>${cost.operation}</td>
                <td>${formatUsd(cost.usdMicros)}</td>
                <td>${formatTime(cost.createdAt)}</td>
              </tr>`,
            )}
          </tbody>
        </table>`

  const libraryState =
    detail.libraryState === null
      ? html`<span class="muted">not in library</span>`
      : html`<span class="status-${detail.libraryState}">${detail.libraryState}</span>`

  return html`<h1>job ${job.id}</h1>
    <div class="panel">
      <table>
        <tbody>
          <tr><th>channel</th><td>${job.channel}</td></tr>
          <tr><th>tier</th><td>${job.tier}</td></tr>
          <tr><th>topic</th><td>${job.topic}</td></tr>
          <tr><th>status</th><td class="status-${job.status}">${job.status}</td></tr>
          <tr><th>created</th><td>${formatTime(job.createdAt)}</td></tr>
          <tr><th>finished</th><td>${formatTime(job.finishedAt)}</td></tr>
          <tr><th>total spend</th><td>${formatUsd(job.costUsdMicros)}</td></tr>
          <tr><th>library</th><td>${libraryState}</td></tr>
          <tr><th>artifacts</th><td><code>${runsRoot}/${job.id}/</code></td></tr>
        </tbody>
      </table>
    </div>
    ${video}
    <div class="panel">
      <h2>stages</h2>
      <table>
        <thead><tr><th>stage</th><th>status</th><th>duration</th><th>started</th></tr></thead>
        <tbody>${detail.stages.map(stageRow)}</tbody>
      </table>
    </div>
    <div class="panel">
      <h2>spend</h2>
      ${costs}
    </div>
    <p><a href="${href('/jobs')}">← all jobs</a></p>`
}
