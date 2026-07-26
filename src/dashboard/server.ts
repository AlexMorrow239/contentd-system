import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs'
import { Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import type { Database } from 'better-sqlite3'
import { Hono } from 'hono'
import { openDbReadonly } from '../db/index.js'
import type { LibraryState } from '../jobs/library.js'
import { tryLoadChannelsDir } from '../config/channel.js'
import type { ChannelConfig } from '../config/channel.js'
import { uploadsUsedToday } from '../publish/publishes.js'
import { localDay } from '../publish/schedule.js'
import { PUBLISH_PLATFORMS } from '../publish/types.js'
import { PLATFORM_QUOTAS, ytUploadsPerDayCap } from '../publish/platforms/quota.js'
import type { DashboardConfig, DbChoice } from './config.js'
import { resolveDbChoice } from './config.js'
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
  dbChoice: DbChoice
}

export interface DashboardDeps {
  config: DashboardConfig
  /** Injectable clock so time-dependent views are testable. */
  now?: () => Date
}

const cssPath = fileURLToPath(new URL('./static/dashboard.css', import.meta.url))

const JOB_STATUS_VALUES: JobStatus[] = ['queued', 'running', 'failed', 'done', 'blocked']
const LIBRARY_STATE_VALUES: LibraryState[] = ['ready', 'needs-review', 'published', 'blocked']
const TOPIC_STATUS_VALUES: TopicStatus[] = ['candidate', 'claimed', 'used', 'rejected']

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
      db = openAndValidate(dbPath)
    } catch (err) {
      // Never the DB contents or env values — just path/choice and the
      // driver's own message, which is what an operator needs mid-incident.
      console.error(`dashboard: failed to open ${dbChoice} database at ${dbPath}:`, err)
      // existsSync, not matching on the SQLite error code: it's the more
      // direct way to ask the actual question ("is the file there?") and
      // doesn't depend on which error shape better-sqlite3 throws.
      if (!existsSync(dbPath)) {
        return c.html(missingDbPage(dbPath, dbChoice), 503)
      }
      const message = err instanceof Error ? err.message : String(err)
      return c.html(corruptDbPage(dbPath, dbChoice, message), 503)
    }
    c.set('db', db)
    c.set('dbChoice', dbChoice)
    try {
      await next()
    } finally {
      db.close()
    }
  })

  app.get('/', (c) => {
    const db = c.get('db')
    const dbChoice = c.get('dbChoice')
    const now = deps.now?.() ?? new Date()
    const { channels, error } = tryLoadChannelsDir(deps.config.channelsDir)

    return c.html(
      layout({
        title: 'overview',
        dbChoice,
        activeNav: 'overview',
        refreshSeconds: 30,
        body: renderOverviewPage(
          buildOverview(db, channels, now, ytUploadsPerDayCap()),
          dbChoice,
          error,
        ),
      }),
    )
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
          total: countJobs(db, { channel, status }),
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

  app.get('/library', (c) => {
    const db = c.get('db')
    const dbChoice = c.get('dbChoice')
    const rawState = c.req.query('state')
    const state = LIBRARY_STATE_VALUES.includes(rawState as LibraryState)
      ? (rawState as LibraryState)
      : undefined
    const rawChannel = c.req.query('channel')
    const channel = rawChannel !== undefined && rawChannel !== '' ? rawChannel : undefined

    return c.html(
      layout({
        title: 'library',
        dbChoice,
        activeNav: 'library',
        body: renderLibraryPage({
          entries: listLibraryEntries(db, { state, channel }),
          total: countLibraryEntries(db, { state, channel }),
          channels: libraryChannels(db),
          filter: { state, channel },
          dbChoice,
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
    const absolute = resolveVideoPath(deps.config.runsRoot, videoPath)
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
    const dbChoice = c.get('dbChoice')
    const now = deps.now?.() ?? new Date()

    const rawDays = Number(c.req.query('days') ?? '14')
    const days = Number.isInteger(rawDays) && rawDays > 0 && rawDays <= 90 ? rawDays : 14

    // tryLoadChannelsDir, not loadChannelsDir: a broken TOML degrades one
    // panel into a warning instead of 500-ing the page.
    const { channels, error } = tryLoadChannelsDir(deps.config.channelsDir)

    return c.html(
      layout({
        title: 'publishes',
        dbChoice,
        activeNav: 'publishes',
        body: renderPublishesPage({
          grids: buildPublishGrids(db, channels, days, now),
          days,
          quotas: buildPlatformQuotas(db, channels, localDay(now)),
          dbChoice,
          configError: error,
        }),
      }),
    )
  })

  app.get('/topics', (c) => {
    const db = c.get('db')
    const dbChoice = c.get('dbChoice')
    const rawStatus = c.req.query('status')
    const status = TOPIC_STATUS_VALUES.includes(rawStatus as TopicStatus)
      ? (rawStatus as TopicStatus)
      : undefined
    const rawChannel = c.req.query('channel')
    const channel = rawChannel !== undefined && rawChannel !== '' ? rawChannel : undefined

    return c.html(
      layout({
        title: 'topics',
        dbChoice,
        activeNav: 'topics',
        body: renderTopicsPage({
          topics: listTopics(db, { channel, status, limit: 200 }),
          total: countTopics(db, { channel, status }),
          // A dedicated query, not a second listTopics(db) call: this is the
          // full unfiltered channel set for the dropdown, not filtered rows.
          channels: topicChannels(db),
          filter: { channel, status },
          dbChoice,
        }),
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
    // Also logged: rendering it to the browser was the only record before
    // this, and `docker compose logs dashboard` had nothing for an incident.
    console.error(`dashboard: unhandled error on ${c.req.method} ${c.req.path}:`, err)
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

/**
 * Reuses the same quota descriptors the publish loop enforces against
 * (PLATFORM_QUOTAS — which is exactly what each adapter exposes as
 * `adapter.quota`, and what publish-next.ts's own quota gate reads) rather
 * than a mirrored copy that could silently drift. Imported from the leaf
 * quota module, not through ADAPTERS: a read-only viewer has no business
 * pulling upload mechanics and credential code into its process to read
 * three static fields. 'global' (YouTube: one shared
 * Google Cloud project quota) reports one all-channels figure; 'channel'
 * (Instagram: one IG account per channel) has no single meaningful "used"
 * total to sum against the single per-channel `cap`, so it reports a
 * per-channel breakdown instead — summing usage across channels against a
 * cap that applies separately to EACH channel would misreport how much
 * headroom any one channel actually has left.
 */
function buildPlatformQuotas(
  db: Database,
  channels: ChannelConfig[],
  day: string,
): PlatformQuotaView[] {
  return PUBLISH_PLATFORMS.map((platform) => {
    const quota = PLATFORM_QUOTAS[platform]
    if (quota.scope === 'global') {
      return {
        platform,
        scope: 'global',
        cap: quota.cap(),
        used: uploadsUsedToday(db, platform, day),
      }
    }
    const perChannel = channels
      .filter((channel) => channel.publish?.targets.some((t) => t.platform === platform) === true)
      .map((channel) => ({
        channel: channel.name,
        used: uploadsUsedToday(db, platform, day, channel.name),
      }))
    return { platform, scope: 'channel', cap: quota.cap(), perChannel }
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

function corruptDbPage(dbPath: string, dbChoice: DbChoice, message: string): string {
  return layout({
    title: 'database could not be opened',
    dbChoice,
    activeNav: 'overview',
    body: html`<h1>database could not be opened</h1>
      <p class="muted">
        The ${dbChoice} database at <code>${dbPath}</code> is present but could not be opened:
      </p>
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
  console.log(`dashboard listening on :${config.port} (prod db: ${config.dbPaths.prod})`)
}
