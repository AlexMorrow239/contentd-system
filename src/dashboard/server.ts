import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs'
import { Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import type { Database } from 'better-sqlite3'
import { Hono } from 'hono'
import { openDbActions, openDbReadonly } from '../db/index.js'
import { errorMessage } from '../errors.js'
import type { LibraryState } from '../jobs/library.js'
import { tryLoadChannelsDir } from '../config/channel.js'
import type { ChannelConfig } from '../config/channel.js'
import { quotaBackedOff, uploadsUsedToday } from '../publish/publishes.js'
import { localDay } from '../publish/schedule.js'
import { PUBLISH_PLATFORMS } from '../publish/types.js'
import { PLATFORM_QUOTAS } from '../publish/platforms/quota.js'
import { enqueueAction } from '../actions/queue.js'
import { formToArgs, isActionKind, parseActionArgs } from '../actions/catalog.js'
import { CSRF_FIELD, csrfFailure, mintCsrfToken } from './csrf.js'
import type { DashboardConfig } from './config.js'
import { html } from './html.js'
import {
  countLibraryEntries,
  findLibraryVideoPath,
  libraryChannels,
  listLibraryEntries,
} from './queries/library.js'
import { countJobs, getJobDetail, jobChannels, listJobs } from './queries/jobs.js'
import type { JobStatus } from './queries/jobs.js'
import { buildOverview } from './queries/overview.js'
import { buildPublishGrids } from './queries/publishes.js'
import { countTopics, topicChannels } from './queries/topics.js'
import { listTopics } from '../scout/topics.js'
import type { TopicStatus } from '../scout/topics.js'
import { parseRange, resolveVideoPath } from './video.js'
import { renderLibraryPage } from './views/library.js'
import { renderJobDetailPage, renderJobsPage } from './views/jobs.js'
import { layout } from './views/layout.js'
import { renderOverviewPage } from './views/overview.js'
import { renderPublishesPage } from './views/publishes.js'
import type { PlatformQuotaView } from './views/publishes.js'
import { renderTopicsPage } from './views/topics.js'

export interface DashboardVars {
  db: Database
}

export interface DashboardDeps {
  config: DashboardConfig
  /** Injectable clock so time-dependent views are testable. */
  now?: () => Date
  /** Injectable so route tests can post a known token. */
  csrfToken?: string
}

const cssPath = fileURLToPath(new URL('./static/dashboard.css', import.meta.url))

const JOB_STATUS_VALUES: JobStatus[] = ['queued', 'running', 'failed', 'done', 'blocked']
const LIBRARY_STATE_VALUES: LibraryState[] = ['ready', 'needs-review', 'published', 'blocked']
const TOPIC_STATUS_VALUES: TopicStatus[] = ['candidate', 'claimed', 'used', 'rejected']

export function createApp(deps: DashboardDeps): Hono<{ Variables: DashboardVars }> {
  const app = new Hono<{ Variables: DashboardVars }>()
  // `deps.csrfToken ?? mintCsrfToken()` alone is not enough: `??` only
  // substitutes on null/undefined, so an explicit `csrfToken: ''` (a
  // misconfigured deps object, or a future test) would sail straight through
  // and become the expected token — and csrfFailure's timingSafeEqual-based
  // compare treats two empty strings as a match. `||` also treats '' as
  // absent, which is exactly the fallback wanted here.
  const csrfToken = deps.csrfToken || mintCsrfToken()

  // Registered BEFORE the db middleware on purpose: Hono dispatches matching
  // handlers in registration order, so the stylesheet is served even when the
  // database is missing — which is exactly when you want a readable page.
  app.get('/static/dashboard.css', (c) => {
    return c.body(readFileSync(cssPath, 'utf8'), 200, { 'content-type': 'text/css; charset=utf-8' })
  })

  // Registered ahead of the read-only db middleware on purpose: this is the
  // one route that writes, and it must not inherit the readonly connection
  // every other route depends on. Its own handle inserts a single queue row
  // and closes.
  app.post('/actions', async (c) => {
    // The body must be read before the CSRF/origin check runs — the
    // submitted token only exists in the body, and csrfFailure is atomic
    // over all four of its checks (it cannot be told "just check origin
    // first"). That means a cross-site page can make this process buffer a
    // body it will then refuse; accepted as a consequence of the zero-JS
    // form design rather than something worth a second parse pass to avoid.
    let form: FormData
    try {
      form = await c.req.formData()
    } catch (err) {
      return c.html(
        actionErrorPage(deps.config.paths.root, `could not read the submitted form: ${errorMessage(err)}`),
        400,
      )
    }
    const entries: [string, string][] = []
    for (const [key, value] of form.entries()) {
      if (typeof value === 'string') entries.push([key, value])
    }
    const fields = formToArgs(entries)

    // csrfFailure reads its token via a header lookup (a private constant
    // inside csrf.ts, not exported), but this dashboard ships zero
    // client-side JS: a plain <form> POST can never set a custom header, so
    // the token can only travel as the hidden `csrf` body field (CSRF_FIELD).
    // This shim is the bridge — it answers ONLY the CSRF token header lookup
    // from the submitted form field; every other header name (including any
    // csrf.ts adds in the future) falls through to the real request headers,
    // which for a plain form POST are genuinely absent. The default must
    // fail CLOSED, not open: answering an unrecognized header name with
    // operator-supplied form data would let a future site-identity check
    // added to csrfFailure be satisfied from the body instead of a real,
    // unspoofable browser header.
    const submittedToken = typeof fields[CSRF_FIELD] === 'string' ? fields[CSRF_FIELD] : ''
    const refusal = csrfFailure(
      {
        header: (name) =>
          name.toLowerCase() === 'x-brainrot-csrf'
            ? submittedToken
            : (c.req.header(name) ?? undefined),
      },
      csrfToken,
    )
    if (refusal !== null) return c.html(actionErrorPage(deps.config.paths.root, refusal), 403)

    const kind = typeof fields.kind === 'string' ? fields.kind : ''
    if (!isActionKind(kind)) {
      return c.html(
        actionErrorPage(deps.config.paths.root, `unknown action ${JSON.stringify(kind)}`),
        400,
      )
    }
    // `kind`, the token and the return path are transport, not arguments —
    // stripped by name rather than by destructuring so no unused bindings are
    // introduced and the excluded set stays readable.
    const TRANSPORT_FIELDS = new Set(['kind', CSRF_FIELD, 'from'])
    const rest = Object.fromEntries(
      Object.entries(fields).filter(([key]) => !TRANSPORT_FIELDS.has(key)),
    )
    let args: unknown
    try {
      args = parseActionArgs(kind, rest)
    } catch (err) {
      return c.html(actionErrorPage(deps.config.paths.root, errorMessage(err)), 400)
    }

    let db: Database
    try {
      db = openDbActions(deps.config.paths.dbPath)
    } catch (err) {
      return c.html(
        actionErrorPage(
          deps.config.paths.root,
          `could not open the database for writing: ${errorMessage(err)}`,
        ),
        503,
      )
    }
    let id: number
    try {
      id = enqueueAction(db, { kind, args, requestedBy: 'dashboard' })
    } catch (err) {
      // The commonest cause is a database no openDb call has ever touched, so
      // operator_actions does not exist yet. Say so rather than 500-ing.
      return c.html(
        actionErrorPage(
          deps.config.paths.root,
          `could not queue the action: ${errorMessage(err)} — start the daemon once against this root to initialize the schema.`,
        ),
        503,
      )
    } finally {
      db.close()
    }

    // `from` is operator-controlled, so only a same-site absolute path is
    // honoured; anything else falls back to /actions. Without this the
    // dashboard would be an open redirect.
    const from = typeof fields.from === 'string' ? fields.from : ''
    const target = sameSitePath(from) ?? '/actions'
    const separator = target.includes('?') ? '&' : '?'
    return c.redirect(`${target}${separator}action=${String(id)}`, 303)
  })

  // One read-only connection per request. Opening SQLite is sub-millisecond,
  // and a per-request handle means no stale connection survives a cron tick's
  // checkpoint. Closed in a finally so a throwing route cannot leak it.
  app.use('*', async (c, next) => {
    const dbPath = deps.config.paths.dbPath
    let db: Database
    try {
      db = openAndValidate(dbPath)
    } catch (err) {
      // Never the DB contents or env values — just the path and the driver's
      // own message, which is what an operator needs mid-incident.
      console.error(`dashboard: failed to open database at ${dbPath}:`, err)
      if (!existsSync(dbPath)) {
        return c.html(missingDbPage(dbPath, deps.config.paths.root), 503)
      }
      return c.html(corruptDbPage(dbPath, deps.config.paths.root, errorMessage(err)), 503)
    }
    c.set('db', db)
    try {
      await next()
    } finally {
      db.close()
    }
  })

  app.get('/', (c) => {
    const db = c.get('db')
    const now = deps.now?.() ?? new Date()
    const { channels, error } = tryLoadChannelsDir(deps.config.paths.channelsDir)

    return c.html(
      layout({
        title: 'overview',
        root: deps.config.paths.root,
        activeNav: 'overview',
        refreshSeconds: 30,
        body: renderOverviewPage(buildOverview(db, channels, now), error),
      }),
    )
  })

  app.get('/jobs', (c) => {
    const db = c.get('db')
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
        root: deps.config.paths.root,
        activeNav: 'jobs',
        body: renderJobsPage({
          jobs: listJobs(db, { channel, status }),
          total: countJobs(db, { channel, status }),
          channels: jobChannels(db),
          filter: { channel, status },
        }),
      }),
    )
  })

  app.get('/jobs/:id', (c) => {
    const db = c.get('db')
    const detail = getJobDetail(db, c.req.param('id'))
    if (detail === null) {
      return c.html(
        layout({
          title: 'job not found',
          root: deps.config.paths.root,
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
        root: deps.config.paths.root,
        activeNav: 'jobs',
        body: renderJobDetailPage(detail, deps.config.paths.runsRoot),
      }),
    )
  })

  app.get('/library', (c) => {
    const db = c.get('db')
    const rawState = c.req.query('state')
    const state = LIBRARY_STATE_VALUES.includes(rawState as LibraryState)
      ? (rawState as LibraryState)
      : undefined
    const rawChannel = c.req.query('channel')
    const channel = rawChannel !== undefined && rawChannel !== '' ? rawChannel : undefined

    return c.html(
      layout({
        title: 'library',
        root: deps.config.paths.root,
        activeNav: 'library',
        body: renderLibraryPage({
          entries: listLibraryEntries(db, { state, channel }),
          total: countLibraryEntries(db, { state, channel }),
          channels: libraryChannels(db),
          filter: { state, channel },
        }),
      }),
    )
  })

  app.get('/library/:jobId/video', (c) => {
    const db = c.get('db')
    const videoPath = findLibraryVideoPath(db, c.req.param('jobId'))
    if (videoPath === null) return c.text('no library row for this job', 404)

    // The path comes from the database, never the URL — and is still
    // containment-checked, so a malformed row cannot read outside runs/.
    const absolute = resolveVideoPath(deps.config.paths.runsRoot, videoPath)
    if (absolute === null) return c.text('video path outside the runs root', 403)

    let size: number
    try {
      size = statSync(absolute).size
    } catch {
      return c.text('video file missing on disk', 404)
    }

    const range = parseRange(c.req.header('range'), size)
    if (range === null) {
      const stream = Readable.toWeb(createReadStream(absolute)) as ReadableStream
      return new Response(stream, {
        status: 200,
        headers: {
          'content-type': 'video/mp4',
          'content-length': String(size),
          'accept-ranges': 'bytes',
        },
      })
    }

    const stream = Readable.toWeb(
      createReadStream(absolute, { start: range.start, end: range.end }),
    ) as ReadableStream
    return new Response(stream, {
      status: 206,
      headers: {
        'content-type': 'video/mp4',
        'content-length': String(range.end - range.start + 1),
        'content-range': `bytes ${range.start}-${range.end}/${size}`,
        'accept-ranges': 'bytes',
      },
    })
  })

  app.get('/publishes', (c) => {
    const db = c.get('db')
    const now = deps.now?.() ?? new Date()

    const rawDays = Number(c.req.query('days') ?? '14')
    const days = Number.isInteger(rawDays) && rawDays > 0 && rawDays <= 90 ? rawDays : 14

    // tryLoadChannelsDir, not loadChannelsDir: a broken TOML degrades one
    // panel into a warning instead of 500-ing the page.
    const { channels, error } = tryLoadChannelsDir(deps.config.paths.channelsDir)

    return c.html(
      layout({
        title: 'publishes',
        root: deps.config.paths.root,
        activeNav: 'publishes',
        body: renderPublishesPage({
          grids: buildPublishGrids(db, channels, days, now),
          days,
          quotas: buildPlatformQuotas(db, channels, localDay(now), now),
          configError: error,
        }),
      }),
    )
  })

  app.get('/topics', (c) => {
    const db = c.get('db')
    const rawStatus = c.req.query('status')
    const status = TOPIC_STATUS_VALUES.includes(rawStatus as TopicStatus)
      ? (rawStatus as TopicStatus)
      : undefined
    const rawChannel = c.req.query('channel')
    const channel = rawChannel !== undefined && rawChannel !== '' ? rawChannel : undefined

    return c.html(
      layout({
        title: 'topics',
        root: deps.config.paths.root,
        activeNav: 'topics',
        body: renderTopicsPage({
          topics: listTopics(db, { channel, status, limit: 200 }),
          total: countTopics(db, { channel, status }),
          // A dedicated query, not a second listTopics(db) call: this is the
          // full unfiltered channel set for the dropdown, not filtered rows.
          channels: topicChannels(db),
          filter: { channel, status },
        }),
      }),
    )
  })

  app.notFound((c) => {
    return c.html(
      layout({
        title: 'not found',
        root: deps.config.paths.root,
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
    // Also logged: rendering it to the browser was the only record before
    // this, and `docker compose logs dashboard` had nothing for an incident.
    console.error(`dashboard: unhandled error on ${c.req.method} ${c.req.path}:`, err)
    return c.html(
      layout({
        title: 'error',
        root: deps.config.paths.root,
        activeNav: 'overview',
        body: html`<h1>error</h1>
          <p class="error">${errorMessage(err)}</p>`,
      }),
      500,
    )
  })

  return app
}

/**
 * Reuses the same quota SCOPE descriptors the publish loop enforces against
 * (PLATFORM_QUOTAS — which is exactly what each adapter exposes as
 * `adapter.quota`, and what publish-next.ts's own quota gate reads) rather
 * than a mirrored copy that could silently drift. Imported from the leaf
 * quota module, not through ADAPTERS: a read-only viewer has no business
 * pulling upload mechanics and credential code into its process to read one
 * static field. 'global' (YouTube: one shared Google Cloud project quota)
 * reports one all-channels figure; 'channel' (Instagram: one IG account per
 * channel) has no single meaningful "used" total to report, so it reports a
 * per-channel breakdown instead — summing usage across channels that are
 * each rate-limited independently would misreport how much headroom any one
 * channel actually has left. `backedOff` reads quotaBackedOff — a SELECT
 * against `publishes`, so this stays read-only like every other dashboard
 * query.
 */
function buildPlatformQuotas(
  db: Database,
  channels: ChannelConfig[],
  day: string,
  now: Date,
): PlatformQuotaView[] {
  return PUBLISH_PLATFORMS.map((platform) => {
    const quota = PLATFORM_QUOTAS[platform]
    if (quota.scope === 'global') {
      return {
        platform,
        scope: 'global',
        used: uploadsUsedToday(db, platform, day),
        backedOff: quotaBackedOff(db, platform, now),
      }
    }
    const perChannel = channels
      .filter((channel) => channel.publish?.targets.some((t) => t.platform === platform) === true)
      .map((channel) => ({
        channel: channel.name,
        used: uploadsUsedToday(db, platform, day, channel.name),
        backedOff: quotaBackedOff(db, platform, now, channel.name),
      }))
    return { platform, scope: 'channel', perChannel }
  })
}

/**
 * openDbReadonly does not eagerly read the file header on open — a
 * corrupt-but-present file only throws once some route runs its first real
 * query, deep inside an onError 500 with no distinguishing information.
 * schema_version is a cheap read-only probe that forces the header read here,
 * right alongside the missing-file case, so both are caught in one place.
 */
function openAndValidate(dbPath: string): Database {
  const db = openDbReadonly(dbPath)
  try {
    db.pragma('schema_version')
  } catch (err) {
    db.close()
    throw err
  }
  return db
}

/**
 * The 303 target. `from` is operator-controlled, so it is validated by
 * PARSING rather than by prefix checks: browsers resolve a Location header
 * under WHATWG URL rules, where `\` is equivalent to `/` in a special
 * scheme — so `startsWith('/') && !startsWith('//')` still lets
 * `/\evil.example` resolve to http://evil.example. Anything that does not
 * resolve back to the sentinel origin is refused.
 */
function sameSitePath(from: string): string | null {
  if (!from.startsWith('/')) return null
  let resolved: URL
  try {
    resolved = new URL(from, 'http://brainrot.invalid')
  } catch {
    return null
  }
  if (resolved.origin !== 'http://brainrot.invalid') return null
  return `${resolved.pathname}${resolved.search}`
}

function actionErrorPage(root: string, message: string): string {
  return layout({
    title: 'action refused',
    root,
    activeNav: 'actions',
    body: html`<h1>action refused</h1>
      <p class="error">${message}</p>
      <p class="muted"><a href="/actions">back to actions</a></p>`,
  })
}

function missingDbPage(dbPath: string, root: string): string {
  return layout({
    title: 'no database',
    root,
    activeNav: 'overview',
    body: html`<h1>no database at <code>${dbPath}</code></h1>
      <p class="muted">
        The database does not exist. The dashboard never creates it — that is the pipeline's job.
      </p>`,
  })
}

function corruptDbPage(dbPath: string, root: string, message: string): string {
  return layout({
    title: 'database could not be opened',
    root,
    activeNav: 'overview',
    body: html`<h1>database could not be opened</h1>
      <p class="muted">The database at <code>${dbPath}</code> is present but could not be opened:</p>
      <p class="error">${message}</p>`,
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
  console.log(`dashboard listening on :${config.port} (root: ${config.paths.root})`)
}
