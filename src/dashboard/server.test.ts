import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from '../db/index.js'
import { localDay } from '../publish/schedule.js'
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

  it('distinguishes a corrupt-but-present database from a missing one', async () => {
    const config = seededConfig()
    // A present-but-not-SQLite file: better-sqlite3 throws on open, but
    // existsSync is true, so the operator must not be told it "does not exist".
    writeFileSync(config.dbPaths.dev, 'not a sqlite file')
    const res = await createApp({ config }).request('/jobs?db=dev')
    expect(res.status).toBe(503)
    const body = await res.text()
    expect(body).not.toContain('does not exist')
    expect(body).toContain('could not be opened')
  })

  it('logs the underlying error when the database fails to open', async () => {
    const config = seededConfig()
    writeFileSync(config.dbPaths.dev, 'not a sqlite file')
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const res = await createApp({ config }).request('/jobs?db=dev')
      expect(res.status).toBe(503)
      expect(spy).toHaveBeenCalled()
    } finally {
      spy.mockRestore()
    }
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

  it('logs an unhandled route error instead of only rendering it', async () => {
    const app = createApp({ config: seededConfig() })
    app.get('/boom', () => {
      throw new Error('kaboom')
    })
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const res = await app.request('/boom')
      expect(res.status).toBe(500)
      expect(spy).toHaveBeenCalled()
    } finally {
      spy.mockRestore()
    }
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
    expect(body).toContain('youtube: 0 / 3 uploads used today')
  })

  it('says so when no channel has an instagram target configured', async () => {
    const config = seededConfig() // channelsDir has no files at all
    mkdirSync(config.channelsDir, { recursive: true })
    const res = await createApp({ config }).request('/publishes')
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toContain('instagram: no channel has a [publish.instagram] target configured')
  })

  it('reports instagram quota per channel — same cap, independent usage — instead of one summed figure', async () => {
    // Instagram's quota is channel-scoped (one IG account per channel, all
    // capped at the same BRAINROT_IG_UPLOADS_PER_DAY): a channel with its
    // own [publish.instagram] table must get its own line, and one
    // channel's usage must never be added into another's.
    vi.stubEnv('BRAINROT_IG_UPLOADS_PER_DAY', '4')
    const config = seededConfig()
    mkdirSync(config.channelsDir, { recursive: true })
    writeFileSync(
      join(config.channelsDir, 'space.toml'),
      [
        'name = "space"',
        'niche = ["space facts"]',
        'script_model = "claude-sonnet-5"',
        'bg_dir = "assets/bg"',
        'bgm_dir = "assets/bgm"',
        'videos_per_day = 1',
        '',
        '[voice]',
        'volume = "af_heart"',
        '',
        '[caption_style]',
        'font = "Inter"',
        'font_size_px = 72',
        'active_color = "#FFD700"',
        'inactive_color = "#FFFFFF"',
        'stroke_px = 8',
        '',
        '[budget]',
        'per_video_usd = 8.0',
        'per_day_usd = 20.0',
        '',
        '[publish]',
        'slots = ["10:00"]',
        '',
        '[publish.instagram]',
        'ig_user_id = "1"',
        '',
      ].join('\n'),
    )
    const now = new Date()
    const today = localDay(now)
    const db = openDb(config.dbPaths.prod)
    db.prepare(
      "INSERT INTO jobs (id, channel, tier, topic, status) VALUES ('j1','space','volume','Venus','done')",
    ).run()
    db.prepare(
      'INSERT INTO publishes (job_id, platform, channel, day, slot, status, attempt) ' +
        "VALUES ('j1','instagram','space',?,'10:00','done',1)",
    ).run(today)
    db.close()

    const res = await createApp({ config, now: () => now }).request('/publishes')
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toContain('space: 1 / 4')
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

describe('unbounded list truncation', () => {
  function configWithManyJobs(count: number): DashboardConfig {
    const config = seededConfig()
    const db = openDb(config.dbPaths.prod)
    const insert = db.prepare(
      "INSERT INTO jobs (id, channel, tier, topic, status) VALUES (?, 'space', 'volume', 'x', 'done')",
    )
    for (let i = 0; i < count; i++) insert.run(`j${i}`)
    db.close()
    return config
  }

  function configWithManyTopics(count: number): DashboardConfig {
    const config = seededConfig()
    const db = openDb(config.dbPaths.prod)
    const insert = db.prepare(
      'INSERT INTO topics (channel, title, raw_title, source, url, dedupe_hash, score, reason, status) ' +
        "VALUES ('space', ?, ?, 'reddit', 'https://x', ?, 50, 'ok', 'candidate')",
    )
    for (let i = 0; i < count; i++) insert.run(`t${i}`, `t${i}`, `hash${i}`)
    db.close()
    return config
  }

  function configWithManyLibraryEntries(count: number): DashboardConfig {
    const config = seededConfig()
    const db = openDb(config.dbPaths.prod)
    const insertJob = db.prepare(
      "INSERT INTO jobs (id, channel, tier, topic, status) VALUES (?, 'space', 'volume', 'x', 'done')",
    )
    const insertLib = db.prepare(
      "INSERT INTO library (job_id, video_path, metadata_json, state) VALUES (?, ?, '{}', 'ready')",
    )
    for (let i = 0; i < count; i++) {
      insertJob.run(`j${i}`)
      insertLib.run(`j${i}`, `runs/j${i}/assemble/final.mp4`)
    }
    db.close()
    return config
  }

  it('/jobs shows a truncation notice past the 200-row cap', async () => {
    const config = configWithManyJobs(201)
    const res = await createApp({ config }).request('/jobs')
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('showing 200 of 201')
  })

  it('/jobs shows no notice when under the cap', async () => {
    const config = configWithManyJobs(5)
    const res = await createApp({ config }).request('/jobs')
    expect(await res.text()).not.toContain('showing')
  })

  it('/topics shows a truncation notice past the 200-row cap', async () => {
    const config = configWithManyTopics(201)
    const res = await createApp({ config }).request('/topics')
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('showing 200 of 201')
  })

  it('/topics shows no notice when under the cap', async () => {
    const config = configWithManyTopics(5)
    const res = await createApp({ config }).request('/topics')
    expect(await res.text()).not.toContain('showing')
  })

  it('/library shows a truncation notice past the 200-row cap', async () => {
    const config = configWithManyLibraryEntries(201)
    const res = await createApp({ config }).request('/library')
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('showing 200 of 201')
  })

  it('/library shows no notice when under the cap', async () => {
    const config = configWithManyLibraryEntries(5)
    const res = await createApp({ config }).request('/library')
    expect(await res.text()).not.toContain('showing')
  })
})
