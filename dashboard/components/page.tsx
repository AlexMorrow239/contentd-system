import type { Database } from 'better-sqlite3'
import Link from 'next/link'
import { unstable_rethrow } from 'next/navigation'
import type { ReactNode } from 'react'
import 'server-only'
import { getAction } from '../../daemon/src/features/actions/queue'
import { errorMessage } from '../../daemon/src/shared/errors'
import { resolveDashboardConfig, type DashboardConfig } from '../lib/config'
import { csrfToken } from '../lib/runtime'
import { actionsTableExists } from '../lib/server/queries/actions'
import { daemonStaleFor, databaseError, withDashboardDb } from '../lib/server/runtime'
import { Refresh } from './controls'
import { ActionDetail } from './ui'

export type Search = Record<string, string | string[] | undefined>
export interface PageProps {
  searchParams: Promise<Search>
}
export interface PageContext {
  config: DashboardConfig
  token: string
  stale: boolean
  search: Search
}
export function value(search: Search, key: string): string | undefined {
  const raw = search[key]
  return typeof raw === 'string' && raw !== '' ? raw : undefined
}
export async function DashboardPage({
  searchParams,
  refreshSeconds,
  compactActions = false,
  children,
}: PageProps & {
  compactActions?: boolean
  /** A fixed interval, or one read from the page's own data. */
  refreshSeconds?: number | ((db: Database) => number | undefined)
  children: (db: Database, context: PageContext) => ReactNode
}) {
  let config: DashboardConfig
  try {
    config = resolveDashboardConfig()
  } catch (error) {
    return (
      <p className="banner error" role="alert">
        {errorMessage(error)}
      </p>
    )
  }
  const search = await searchParams
  try {
    return withDashboardDb(config.paths.dbPath, (db) => {
      const stale = daemonStaleFor(db, new Date())
      const id = Number(value(search, 'action'))
      const action =
        Number.isSafeInteger(id) && id > 0 && actionsTableExists(db) ? getAction(db, id) : null
      const active = action?.status === 'pending' || action?.status === 'running'
      const body = children(db, { config, token: csrfToken(), stale, search })
      const seconds = active
        ? 3
        : typeof refreshSeconds === 'function'
          ? refreshSeconds(db)
          : refreshSeconds
      return (
        <>
          <Refresh seconds={seconds} />
          {stale && (
            <p className="banner warning" role="status">
              Daemon not running — actions are disabled until it is back up.
            </p>
          )}
          {action && (
            <div aria-live="polite">
              {compactActions ? (
                <p className={action.status === 'failed' ? 'error' : 'muted'}>
                  {action.kind}: {action.status}
                  {action.error && ` — ${action.error}`} ·{' '}
                  <Link href={`/actions?action=${action.id}`}>View action</Link>
                </p>
              ) : (
                <ActionDetail action={action} />
              )}
            </div>
          )}
          {body}
        </>
      )
    })
  } catch (error) {
    // Next's notFound()/redirect() are control flow, not a database failure.
    unstable_rethrow(error)
    return (
      <section className="panel">
        <h1>Dashboard unavailable</h1>
        <p className="error" role="alert">
          {databaseError(config.paths.dbPath, error)}
        </p>
      </section>
    )
  }
}
