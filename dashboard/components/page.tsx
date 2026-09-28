import 'server-only'
import type { ReactNode } from 'react'
import { unstable_rethrow } from 'next/navigation'
import type { Database } from 'better-sqlite3'
import { resolveDashboardConfig, type DashboardConfig } from '../../src/dashboard/config'
import { withDashboardDb, daemonStaleFor, databaseError } from '../../src/dashboard/runtime'
import { actionsTableExists } from '../../src/dashboard/queries/actions'
import { getAction } from '../../src/actions/queue'
import { errorMessage } from '../../src/errors'
import { csrfToken } from '../lib/runtime'
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
export function pick<T extends string>(
  values: readonly T[],
  raw: string | undefined,
): T | undefined {
  return values.find((v) => v === raw)
}

export async function DashboardPage({
  searchParams,
  refreshSeconds,
  children,
}: PageProps & {
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
              <ActionDetail action={action} />
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
