import Link from 'next/link'
import type { ComponentProps, ReactNode } from 'react'
import { Pagination, Table } from './ui'

export function ListHeading({
  title,
  subtitle,
  action,
}: {
  title: string
  subtitle: string
  action: ReactNode
}) {
  return (
    <div className="jobs-heading">
      <div>
        <h1>{title}</h1>
        <p className="subtitle">{subtitle}</p>
      </div>
      {action}
    </div>
  )
}

export function ListResults({
  summary,
  order,
  empty,
  emptyMessage,
  headings,
  pagination,
  children,
}: {
  summary: ReactNode
  order: string
  empty: boolean
  emptyMessage: string
  headings: string[]
  pagination: ComponentProps<typeof Pagination>
  children: ReactNode
}) {
  return (
    <>
      <div className="list-meta">
        <span>{summary}</span>
        <span>{order}</span>
      </div>
      {empty ? (
        <p className="empty">{emptyMessage}</p>
      ) : (
        <div className="jobs-table">
          <Table headings={headings}>{children}</Table>
        </div>
      )}
      <Pagination {...pagination} />
    </>
  )
}

export function ListTitleCell({
  href,
  title,
  children,
}: {
  href: string
  title: string
  children: ReactNode
}) {
  return (
    <td className="job-topic">
      <Link className="job-topic-link" href={href}>
        {title}
      </Link>
      <p className="job-secondary">{children}</p>
    </td>
  )
}
