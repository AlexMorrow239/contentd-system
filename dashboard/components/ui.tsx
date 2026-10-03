import Link from 'next/link'
import type { ReactNode } from 'react'
import type { ActionRow } from '../../daemon/src/features/actions/types.js'
import type { LibraryBytes } from '../lib/server/queries/library'
import { httpUrlOrNull } from '../lib/shared/links'

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
  if (bytes === 'not-retained')
    return <p className="muted">Local files are not retained after posting.</p>
  return <p className="muted">Local video file is missing</p>
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
export function Pagination({
  label,
  page,
  pageCount,
  href,
}: {
  label: string
  page: number
  pageCount: number
  href: (page: number) => string
}) {
  if (pageCount <= 1) return null
  return (
    <nav className="pagination" aria-label={label}>
      {page > 1 ? (
        <Link href={href(page - 1)} scroll={false}>
          Previous page
        </Link>
      ) : (
        <span />
      )}
      <span>
        Page {page} of {pageCount}
      </span>
      {page < pageCount ? (
        <Link href={href(page + 1)} scroll={false}>
          Next page
        </Link>
      ) : (
        <span />
      )}
    </nav>
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
