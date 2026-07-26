import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from '../db/index.js'
import type { DashboardConfig } from './config.js'
import { createApp } from './server.js'

function seededConfig(): DashboardConfig {
  const dir = mkdtempSync(join(tmpdir(), 'brainrot-dash-'))
  const prod = join(dir, 'brainrot.db')
  openDb(prod).close()
  return {
    dbPaths: { prod, dev: join(dir, 'absent.db') },
    runsRoot: join(dir, 'runs'),
    channelsDir: join(dir, 'channels'),
    port: 8787,
  }
}

describe('createApp', () => {
  it('serves the stylesheet without needing a database', async () => {
    // Static assets are registered BEFORE the db middleware; a missing
    // database must not take the CSS down with it.
    const config = seededConfig()
    config.dbPaths.prod = join(tmpdir(), 'definitely-absent.db')
    const res = await createApp({ config }).request('/static/dashboard.css')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/css')
  })

  it('renders a missing-database page instead of crashing', async () => {
    const res = await createApp({ config: seededConfig() }).request('/jobs?db=dev')
    expect(res.status).toBe(503)
    const body = await res.text()
    expect(body).toContain('no database at')
    expect(body).toContain('absent.db')
  })

  it('does not create the database file it failed to find', async () => {
    const config = seededConfig()
    await createApp({ config }).request('/jobs?db=dev')
    const { existsSync } = await import('node:fs')
    expect(existsSync(config.dbPaths.dev)).toBe(false)
  })

  it('defaults to the production database', async () => {
    const res = await createApp({ config: seededConfig() }).request('/jobs')
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('viewing prod')
  })

  it('returns a readable 404 for an unknown path', async () => {
    const res = await createApp({ config: seededConfig() }).request('/nope')
    expect(res.status).toBe(404)
    expect(await res.text()).toContain('not found')
  })

  it('returns a readable 500 rather than an empty response when a route throws', async () => {
    const app = createApp({ config: seededConfig() })
    app.get('/boom', () => {
      throw new Error('kaboom')
    })
    const res = await app.request('/boom')
    expect(res.status).toBe(500)
    expect(await res.text()).toContain('kaboom')
  })
})

describe('/publishes', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('renders with a warning rather than 500-ing when the channels dir is unreadable', async () => {
    const config = seededConfig() // channelsDir points at a directory that does not exist
    const res = await createApp({ config }).request('/publishes')
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('channel config error')
  })

  it('reports the enforced quota cap, not a hardcoded default', async () => {
    // Proves the dashboard reads the same resolver the publish loop enforces
    // against (ytUploadsPerDayCap), rather than a mirrored copy that could
    // silently drift from it.
    vi.stubEnv('BRAINROT_YT_UPLOADS_PER_DAY', '3')
    const config = seededConfig()
    const res = await createApp({ config }).request('/publishes')
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toContain('0 / 3 uploads used today')
  })
})

describe('video streaming', () => {
  function configWithVideo(bytes: Buffer, videoPathInDb?: string): DashboardConfig {
    const dir = mkdtempSync(join(tmpdir(), 'brainrot-vid-'))
    const runsRoot = join(dir, 'runs')
    const videoDir = join(runsRoot, 'j1', 'assemble')
    mkdirSync(videoDir, { recursive: true })
    const videoFile = join(videoDir, 'final.mp4')
    writeFileSync(videoFile, bytes)

    const prod = join(dir, 'brainrot.db')
    const db = openDb(prod)
    db.prepare(
      "INSERT INTO jobs (id, channel, tier, topic, status) VALUES ('j1','space','volume','Venus','done')",
    ).run()
    db.prepare(
      'INSERT INTO library (job_id, video_path, metadata_json, state) VALUES (?, ?, ?, ?)',
    ).run('j1', videoPathInDb ?? videoFile, '{}', 'ready')
    db.close()

    return {
      dbPaths: { prod, dev: join(dir, 'absent.db') },
      runsRoot,
      channelsDir: join(dir, 'channels'),
      port: 8787,
    }
  }

  it('serves the whole file when no Range is sent', async () => {
    const config = configWithVideo(Buffer.from('0123456789'))
    const res = await createApp({ config }).request('/library/j1/video')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('video/mp4')
    expect(res.headers.get('accept-ranges')).toBe('bytes')
    expect(await res.text()).toBe('0123456789')
  })

  it('serves a 206 partial response so the player can seek', async () => {
    const config = configWithVideo(Buffer.from('0123456789'))
    const res = await createApp({ config }).request('/library/j1/video', {
      headers: { range: 'bytes=2-5' },
    })
    expect(res.status).toBe(206)
    expect(res.headers.get('content-range')).toBe('bytes 2-5/10')
    expect(res.headers.get('content-length')).toBe('4')
    expect(await res.text()).toBe('2345')
  })

  it('404s for a job with no library row', async () => {
    const config = configWithVideo(Buffer.from('0123456789'))
    const res = await createApp({ config }).request('/library/nope/video')
    expect(res.status).toBe(404)
  })

  it('404s when the file was deleted from disk', async () => {
    const config = configWithVideo(Buffer.from('0123456789'))
    rmSync(join(config.runsRoot, 'j1', 'assemble', 'final.mp4'))
    const res = await createApp({ config }).request('/library/j1/video')
    expect(res.status).toBe(404)
  })

  it('403s on a video_path that escapes the runs root', async () => {
    // A malformed library row must not become an arbitrary file read.
    const config = configWithVideo(Buffer.from('0123456789'), '/etc/passwd')
    const res = await createApp({ config }).request('/library/j1/video')
    expect(res.status).toBe(403)
  })
})

describe('/', () => {
  it('renders the overview with an auto-refresh', async () => {
    const res = await createApp({ config: seededConfig() }).request('/')
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toContain('<meta http-equiv="refresh" content="30">')
    expect(body).toContain('overview')
  })
})
