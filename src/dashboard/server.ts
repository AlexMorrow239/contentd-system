import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { Database } from 'better-sqlite3'
import { Hono } from 'hono'
import { openDbReadonly } from '../db/index.js'
import type { DashboardConfig, DbChoice } from './config.js'
import { resolveDbChoice } from './config.js'
import { html } from './html.js'
import { getJobDetail, jobChannels, listJobs } from './queries/jobs.js'
import type { JobStatus } from './queries/jobs.js'
import { renderJobDetailPage, renderJobsPage } from './views/jobs.js'
import { layout } from './views/layout.js'

export interface DashboardVars {
  db: Database
  dbChoice: DbChoice
}

export interface DashboardDeps {
  config: DashboardConfig
  /** Injectable clock so time-dependent views are testable. */
  now?: () => Date
}

const cssPath = fileURLToPath(new URL('./static/dashboard.css', import.meta.url))

const JOB_STATUS_VALUES: JobStatus[] = ['queued', 'running', 'failed', 'done', 'blocked']

export function createApp(deps: DashboardDeps): Hono<{ Variables: DashboardVars }> {
  const app = new Hono<{ Variables: DashboardVars }>()

  // Registered BEFORE the db middleware on purpose: Hono dispatches matching
  // handlers in registration order, so the stylesheet is served even when the
  // database is missing — which is exactly when you want a readable page.
  app.get('/static/dashboard.css', (c) => {
    return c.body(readFileSync(cssPath, 'utf8'), 200, { 'content-type': 'text/css; charset=utf-8' })
  })

  // One read-only connection per request. Opening SQLite is sub-millisecond,
  // and a per-request handle means no stale connection survives a cron tick's
  // checkpoint. Closed in a finally so a throwing route cannot leak it.
  app.use('*', async (c, next) => {
    const dbChoice = resolveDbChoice(c.req.query('db'))
    const dbPath = deps.config.dbPaths[dbChoice]
    let db: Database
    try {
      db = openDbReadonly(dbPath)
    } catch {
      return c.html(missingDbPage(dbPath, dbChoice), 503)
    }
    c.set('db', db)
    c.set('dbChoice', dbChoice)
    try {
      await next()
    } finally {
      db.close()
    }
  })

  app.get('/jobs', (c) => {
    const db = c.get('db')
    const dbChoice = c.get('dbChoice')
    // Unrecognized filter values are dropped rather than rejected: a viewer
    // must not 400 on a hand-edited URL.
    const rawStatus = c.req.query('status')
    const status = JOB_STATUS_VALUES.includes(rawStatus as JobStatus)
      ? (rawStatus as JobStatus)
      : undefined
    const rawChannel = c.req.query('channel')
    const channel = rawChannel !== undefined && rawChannel !== '' ? rawChannel : undefined

    return c.html(
      layout({
        title: 'jobs',
        dbChoice,
        activeNav: 'jobs',
        body: renderJobsPage({
          jobs: listJobs(db, { channel, status }),
          channels: jobChannels(db),
          filter: { channel, status },
          dbChoice,
        }),
      }),
    )
  })

  app.get('/jobs/:id', (c) => {
    const db = c.get('db')
    const dbChoice = c.get('dbChoice')
    const detail = getJobDetail(db, c.req.param('id'))
    if (detail === null) {
      return c.html(
        layout({
          title: 'job not found',
          dbChoice,
          activeNav: 'jobs',
          body: html`<h1>no such job</h1>
            <p class="muted">${c.req.param('id')} is not in this database.</p>`,
        }),
        404,
      )
    }
    return c.html(
      layout({
        title: `job ${detail.job.id}`,
        dbChoice,
        activeNav: 'jobs',
        body: renderJobDetailPage(detail, dbChoice),
      }),
    )
  })

  app.notFound((c) => {
    const dbChoice = resolveDbChoice(c.req.query('db'))
    return c.html(
      layout({
        title: 'not found',
        dbChoice,
        activeNav: 'overview',
        body: html`<h1>not found</h1>
          <p class="muted">no route for ${c.req.path}</p>`,
      }),
      404,
    )
  })

  app.onError((err, c) => {
    // A viewer must never be the thing that is broken: show the message,
    // keep the process up, let restart:unless-stopped handle a real crash.
    const dbChoice = resolveDbChoice(c.req.query('db'))
    return c.html(
      layout({
        title: 'error',
        dbChoice,
        activeNav: 'overview',
        body: html`<h1>error</h1>
          <p class="error">${err instanceof Error ? err.message : String(err)}</p>`,
      }),
      500,
    )
  })

  return app
}

function missingDbPage(dbPath: string, dbChoice: DbChoice): string {
  return layout({
    title: 'no database',
    dbChoice,
    activeNav: 'overview',
    body: html`<h1>no database at <code>${dbPath}</code></h1>
      <p class="muted">
        The ${dbChoice} database does not exist. The dashboard never creates it — that is the
        pipeline's job.
      </p>`,
  })
}

// Entrypoint: `pnpm exec tsx src/dashboard/server.ts`. Guarded so importing
// this module in tests never binds a port.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { serve } = await import('@hono/node-server')
  const { resolveDashboardConfig } = await import('./config.js')
  const config = resolveDashboardConfig()
  serve({ fetch: createApp({ config }).fetch, port: config.port, hostname: '0.0.0.0' })
  // Loopback-bound on the HOST side via compose's "127.0.0.1:8787:8787".
  // Inside the container 0.0.0.0 is required for the port mapping to work.
  console.log(`dashboard listening on :${config.port} (prod db: ${config.dbPaths.prod})`)
}
