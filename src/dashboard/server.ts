import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs'
import { Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import type { Database } from 'better-sqlite3'
import { Hono } from 'hono'
import { openDbActions, openDbReadonly } from '../db/index.js'
import { errorMessage } from '../errors.js'
import type { LibraryState } from '../jobs/library.js'
import { tryLoadChannelsDir } from '../config/channel.js'
import { enqueueAction, getAction } from '../actions/queue.js'
import {
  ACTIONS,
  actionArgNames,
  formToArgs,
  isActionKind,
  parseActionArgs,
} from '../actions/catalog.js'
import { daemonIsStale, readDaemonState } from '../loop/daemon-state.js'
import { CSRF_FIELD, csrfFailure, mintCsrfToken } from './csrf.js'
import type { DashboardConfig } from './config.js'
import { html } from './html.js'
import { actionsTableExists, buildActionsPage } from './queries/actions.js'
import {
  countLibraryEntries,
  findLibraryVideoPath,
  libraryChannels,
  listLibraryEntries,
} from './queries/library.js'
import { countJobs, getJobDetail, jobChannels, listJobs } from './queries/jobs.js'
import type { JobStatus } from './queries/jobs.js'
import { buildOverview } from './queries/overview.js'
import { listPostQueue } from './queries/post.js'
import { listPostLog } from './queries/posts.js'
import { countTopics, topicChannels } from './queries/topics.js'
import { listTopics } from '../scout/topics.js'
import type { TopicStatus } from '../scout/topics.js'
import { parseRange, resolveVideoPath } from './video.js'
import { missingTableBanner, renderActionsPage, renderConfirmPage } from './views/actions.js'
import { renderLibraryPage } from './views/library.js'
import { renderJobDetailPage, renderJobsPage } from './views/jobs.js'
import { layout } from './views/layout.js'
import { renderOverviewPage } from './views/overview.js'
import { renderPostQueuePage } from './views/post.js'
import { renderPostLogPage } from './views/posts.js'
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
const LIBRARY_STATE_VALUES: LibraryState[] = ['ready', 'needs-review', 'blocked']
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
        actionErrorPage(
          deps.config.paths.root,
          `could not read the submitted form: ${errorMessage(err)}`,
        ),
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

    // Liveness gate. A queued action against a dead daemon is a lie: nothing
    // drains it, and on restart the whole backlog fires at once — for a slow
    // action that means a pile of renders. The heartbeat is 10s against a 60s
    // threshold, so a stale reading is an outage, not a race.
    //
    // Probed on its OWN read-only handle, opened and closed before the write
    // handle exists. That is what keeps the structural claim literally true:
    // the entire write path is still a single INSERT on `openDbActions`.
    let daemonStale: boolean
    try {
      const probe = openDbReadonly(deps.config.paths.dbPath)
      try {
        daemonStale = daemonStaleFor(probe, deps.now?.() ?? new Date())
      } finally {
        probe.close()
      }
    } catch {
      // Unreadable database — the same conclusion `daemonStaleFor` draws when
      // the table is missing. Fail closed.
      daemonStale = true
    }
    if (daemonStale) {
      return c.html(
        actionErrorPage(
          deps.config.paths.root,
          'daemon not running — queued actions would not execute, so nothing was queued.',
        ),
        409,
      )
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
      // operator_actions does not exist yet — but this catch also sees things
      // like a transient SQLITE_BUSY, which that fix does not address. Lead
      // with the driver's own message and offer the schema explanation as the
      // likely cause, not the only one.
      return c.html(
        actionErrorPage(
          deps.config.paths.root,
          `could not queue the action: ${errorMessage(err)} — if the table is missing, ` +
            'start the daemon once against this root to initialize the schema.',
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

  app.get('/post', (c) => {
    const db = c.get('db')
    const { channels, error } = tryLoadChannelsDir(deps.config.paths.channelsDir)
    const daemonStale = daemonStaleFor(db, deps.now?.() ?? new Date())

    return c.html(
      layout({
        title: 'post',
        root: deps.config.paths.root,
        activeNav: 'post',
        refreshSeconds: actionPollSeconds(db, c.req.query('action')),
        body: renderPostQueuePage({
          cards: listPostQueue(db, channels),
          csrfToken,
          daemonStale,
          configError: error,
        }),
      }),
    )
  })

  app.get('/posts', (c) => {
    const db = c.get('db')

    return c.html(
      layout({
        title: 'posts',
        root: deps.config.paths.root,
        activeNav: 'posts',
        refreshSeconds: actionPollSeconds(db, c.req.query('action')),
        body: renderPostLogPage({ entries: listPostLog(db) }),
      }),
    )
  })

  app.get('/', (c) => {
    const db = c.get('db')
    const now = deps.now?.() ?? new Date()
    const { channels, error } = tryLoadChannelsDir(deps.config.paths.channelsDir)
    const daemonStale = daemonStaleFor(db, now)

    return c.html(
      layout({
        title: 'overview',
        root: deps.config.paths.root,
        activeNav: 'overview',
        refreshSeconds: actionPollSeconds(db, c.req.query('action')) ?? 30,
        body: renderOverviewPage(buildOverview(db, channels, now), error, {
          csrfToken,
          daemonStale,
        }),
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

    const daemonStale = daemonStaleFor(db, deps.now?.() ?? new Date())
    const refreshSeconds = actionPollSeconds(db, c.req.query('action'))
    // configuredChannels feeds jobs.produce's picker, not the filter dropdown
    // above (jobChannels(db)): a channel with zero jobs must still be
    // producible, and a deleted channel's TOML must stop being offered even
    // though its old jobs remain filterable. A broken channels directory
    // degrades to an empty picker (produceForm's existing disabled-span
    // treatment) rather than 500ing the whole jobs page.
    const { channels: configuredChannels } = tryLoadChannelsDir(deps.config.paths.channelsDir)

    return c.html(
      layout({
        title: 'jobs',
        root: deps.config.paths.root,
        activeNav: 'jobs',
        refreshSeconds,
        body: renderJobsPage({
          jobs: listJobs(db, { channel, status }),
          total: countJobs(db, { channel, status }),
          channels: jobChannels(db),
          configuredChannels: configuredChannels.map((c) => c.name),
          filter: { channel, status },
          csrfToken,
          daemonStale,
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

    const daemonStale = daemonStaleFor(db, deps.now?.() ?? new Date())
    const refreshSeconds = actionPollSeconds(db, c.req.query('action'))

    return c.html(
      layout({
        title: 'library',
        root: deps.config.paths.root,
        activeNav: 'library',
        refreshSeconds,
        body: renderLibraryPage({
          entries: listLibraryEntries(db, { state, channel }),
          total: countLibraryEntries(db, { state, channel }),
          channels: libraryChannels(db),
          filter: { state, channel },
          csrfToken,
          daemonStale,
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

  app.get('/topics', (c) => {
    const db = c.get('db')
    const rawStatus = c.req.query('status')
    const status = TOPIC_STATUS_VALUES.includes(rawStatus as TopicStatus)
      ? (rawStatus as TopicStatus)
      : undefined
    const rawChannel = c.req.query('channel')
    const channel = rawChannel !== undefined && rawChannel !== '' ? rawChannel : undefined

    const daemonStale = daemonStaleFor(db, deps.now?.() ?? new Date())
    const refreshSeconds = actionPollSeconds(db, c.req.query('action'))

    return c.html(
      layout({
        title: 'topics',
        root: deps.config.paths.root,
        activeNav: 'topics',
        refreshSeconds,
        body: renderTopicsPage({
          topics: listTopics(db, { channel, status, limit: 200 }),
          total: countTopics(db, { channel, status }),
          // A dedicated query, not a second listTopics(db) call: this is the
          // full unfiltered channel set for the dropdown, not filtered rows.
          channels: topicChannels(db),
          filter: { channel, status },
          csrfToken,
          daemonStale,
        }),
      }),
    )
  })

  app.get('/actions/confirm', (c) => {
    const db = c.get('db')
    const now = deps.now?.() ?? new Date()
    const daemonStale = daemonStaleFor(db, now)

    const kind = c.req.query('kind') ?? ''
    if (!isActionKind(kind) || !ACTIONS[kind].confirm) {
      // A non-confirmable kind is refused rather than rendered: this route
      // builds a POST form, so accepting any kind would make it a second,
      // unguarded path to every action.
      return c.html(
        actionErrorPage(deps.config.paths.root, `no confirmation step for ${JSON.stringify(kind)}`),
        400,
      )
    }
    const rawFrom = c.req.query('from') ?? ''
    const from = sameSitePath(rawFrom) ?? ''

    // Whatever the calling page could supply arrives as query params; the rest
    // becomes a text input. The catalog's schema is the authority on which
    // fields exist, so a hand-edited url cannot smuggle an extra one.
    const names = actionArgNames(kind)
    const fields: Record<string, string> = {}
    const missing: string[] = []
    for (const name of names) {
      const value = c.req.query(name)
      if (value === undefined || value === '') missing.push(name)
      else fields[name] = value
    }

    return c.html(
      layout({
        title: `confirm ${ACTIONS[kind].label}`,
        root: deps.config.paths.root,
        activeNav: 'actions',
        body: renderConfirmPage({ kind, csrfToken, from, fields, missing, daemonStale }),
      }),
    )
  })

  app.get('/actions', (c) => {
    const db = c.get('db')
    const now = deps.now?.() ?? new Date()
    if (!actionsTableExists(db)) {
      return c.html(
        layout({
          title: 'actions',
          root: deps.config.paths.root,
          activeNav: 'actions',
          body: missingTableBanner(),
        }),
      )
    }
    const data = buildActionsPage(db, now)
    const rawId = Number(c.req.query('action') ?? '')
    const highlightId = Number.isInteger(rawId) && rawId > 0 ? rawId : undefined
    return c.html(
      layout({
        title: 'actions',
        root: deps.config.paths.root,
        activeNav: 'actions',
        // A page holding unfinished work refreshes fast enough to show the
        // outcome without the operator touching anything; an idle page does
        // not refresh at all.
        refreshSeconds: data.actions.some((a) => a.status === 'pending' || a.status === 'running')
          ? 3
          : undefined,
        body: renderActionsPage(data, { highlightId }),
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
 * Whether the daemon should be reported down, with the fallback every caller
 * needs: a pre-migration database has no daemon_state table either, so the
 * probe guards both reads — absent means "no daemon has initialized this
 * root," which renders every control disabled rather than 500-ing the
 * viewer.
 */
function daemonStaleFor(db: Database, now: Date): boolean {
  return actionsTableExists(db) ? daemonIsStale(readDaemonState(db), now) : true
}

/**
 * `?action=<id>` marks a just-submitted page: poll briefly so the outcome
 * appears without the operator touching anything — the queue is asynchronous
 * and the PRG redirect lands here before the worker has run. Bounded to
 * while THAT action is still pending/running, not the query param's mere
 * presence — a page left open on `?action=<id>` after the action has already
 * settled must stop polling, not refresh every 3s forever.
 */
function actionPollSeconds(db: Database, rawId: string | undefined): number | undefined {
  const id = Number(rawId ?? '')
  if (!Number.isInteger(id) || id <= 0) return undefined
  const action = getAction(db, id)
  return action !== null && (action.status === 'pending' || action.status === 'running')
    ? 3
    : undefined
}

/**
 * The 303 target. `from` is operator-controlled, so the INPUT is validated by
 * PARSING rather than by prefix checks: browsers resolve a Location header
 * under WHATWG URL rules, where `\` is equivalent to `/` in a special
 * scheme — so `startsWith('/') && !startsWith('//')` still lets
 * `/\evil.example` resolve to http://evil.example. Anything that does not
 * resolve back to the sentinel origin is refused.
 *
 * The OUTPUT is then re-checked, which looks redundant with the input check
 * above but is not: normalization can *produce* a protocol-relative path the
 * input never had. `/..//evil.example` parses same-origin against the
 * sentinel (the `..` and the literal `//evil.example` are still separated by
 * a resolved segment at parse time), but `.pathname` collapses the `..` away
 * and leaves `//evil.example` — which a browser resolves as scheme-relative,
 * off-origin. A normalized `pathname` can never contain a raw backslash
 * (`new URL('/a\\b', …).pathname` is `/a/b`), so a plain prefix check is
 * sound here even though it was not sound on the raw input.
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
  const path = `${resolved.pathname}${resolved.search}`
  // A normalized pathname can never contain a raw backslash, so this
  // output-side prefix check is sound where the input-side one was not.
  if (!path.startsWith('/') || path.startsWith('//')) return null
  return path
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
