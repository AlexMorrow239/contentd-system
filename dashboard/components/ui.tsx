import type { ReactNode } from 'react'
import Link from 'next/link'
import { httpUrlOrNull } from '../../src/dashboard/links'
import type { LibraryBytes } from '../../src/dashboard/queries/library'
import type { ActionRow } from '../../src/actions/queue'

export function formatTime(value: string | null): string {
  if (value === null) return '—'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString()
}
export function formatDuration(start: string | null, end: string | null): string {
  if (!start || !end) return '—'
  const ms = new Date(end).getTime() - new Date(start).getTime()
  if (!Number.isFinite(ms) || ms < 0) return '—'
  if (ms < 1000) return `${ms}ms`
  const sec = Math.round(ms / 1000)
  return sec < 60 ? `${sec}s` : `${Math.floor(sec / 60)}m${String(sec % 60).padStart(2, '0')}s`
}
export function Status({ value }: { value: string }) {
  return <span className={`badge status-${value}`}>{value}</span>
}
export function SafeLink({ url, children }: { url: string | null; children: ReactNode }) {
  return url !== null && httpUrlOrNull(url) !== null ? (
    <a href={url} target="_blank" rel="noopener noreferrer">
      {children} ↗
    </a>
  ) : (
    <span className="muted">{children}</span>
  )
}
export function JobLink({ id }: { id: string }) {
  return <Link href={`/jobs/${encodeURIComponent(id)}`}>{id}</Link>
}
export function Video({ bytes, jobId }: { bytes: LibraryBytes; jobId: string }) {
  if (bytes === 'local')
    return <video controls preload="metadata" src={`/library/${encodeURIComponent(jobId)}/video`} />
  return (
    <p className="muted">
      {bytes === 'archived'
        ? 'Archived to object storage — unavailable locally'
        : bytes === 'reclaimed'
          ? 'Reclaimed — stored bytes intentionally removed'
          : 'Not stored — use backfill store'}
    </p>
  )
}
export function Table({ headings, children }: { headings: string[]; children: ReactNode }) {
  return (
    <div className="table-scroll">
      <table>
        <thead>
          <tr>
            {headings.map((heading, i) => (
              <th key={i} scope="col">
                {heading}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  )
}
export function Truncation({ shown, total }: { shown: number; total: number }) {
  return shown < total ? (
    <p className="muted">
      Showing {shown.toLocaleString()} of {total.toLocaleString()}
    </p>
  ) : null
}
export function Filters({
  path,
  filters,
}: {
  path: string
  filters: { name: string; values: readonly string[]; selected?: string }[]
}) {
  return (
    <form action={path} className="filters" method="get">
      {filters.map((f) => (
        <label key={f.name}>
          {f.name}
          <select
            key={`${f.name}:${f.selected ?? ''}`}
            name={f.name}
            defaultValue={f.selected ?? ''}
          >
            <option value="">All {f.name === 'status' ? 'statuses' : `${f.name}s`}</option>
            {f.values.map((v) => (
              <option key={v} value={v}>
                {v}
              </option>
            ))}
          </select>
        </label>
      ))}
      <button type="submit">Filter</button>
      <Link href={path}>Clear</Link>
    </form>
  )
}
export function ActionDetail({ action }: { action: ActionRow }) {
  return (
    <article className="action-detail" id={`action-${action.id}`}>
      <div className="row">
        <Status value={action.status} />
        <strong>{action.kind}</strong>
        <span className="muted">
          #{action.id} · {action.lane} · {formatTime(action.createdAt)}
        </span>
      </div>
      <code>{action.args}</code>
      {action.error && (
        <p className="error">
          {action.error} ({action.errorKind})
        </p>
      )}
      {action.notice && <p className="warning">{action.notice}</p>}
      {action.result && <pre>{action.result}</pre>}
    </article>
  )
}
