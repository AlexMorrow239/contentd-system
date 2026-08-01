import { afterEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import BetterSqlite3 from 'better-sqlite3'
import { openDb } from '../../db/index.js'
import { localDay } from '../../publish/schedule.js'
import { resolvePaths } from '../../config/paths.js'
import type { DashboardConfig } from '../config.js'
import { createApp } from '../server.js'
import { tmpDir } from '../../testing/tmp.js'

/** A config whose root exists and whose db is present, absent, or corrupt. */
function seededConfig(db: 'present' | 'absent' | 'corrupt' = 'present'): DashboardConfig {
  const paths = resolvePaths(tmpDir('brainrot-dash-'))
  mkdirSync(join(paths.root, 'db'), { recursive: true })
  if (db === 'present') openDb(paths.dbPath).close()
  if (db === 'corrupt') writeFileSync(paths.dbPath, 'not a sqlite file')
  return { paths, port: 8787 }
}

describe('createApp', () => {
  it('serves the stylesheet without needing a database', async () => {
    // Static assets are registered BEFORE the db middleware; a missing
    // database must not take the CSS down with it.
    const config = seededConfig('absent')
    const res = await createApp({ config }).request('/static/dashboard.css')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/css')
  })

  it('renders a missing-database page instead of crashing', async () => {
    const res = await createApp({ config: seededConfig('absent') }).request('/jobs')
    expect(res.status).toBe(503)
    expect(await res.text()).toContain('no database at')
  })

  it('does not create the database file it failed to find', async () => {
    const config = seededConfig('absent')
    await createApp({ config }).request('/jobs')
    expect(existsSync(config.paths.dbPath)).toBe(false)
  })

  it('distinguishes a corrupt-but-present database from a missing one', async () => {
    // A present-but-not-SQLite file: better-sqlite3 throws on open, but
    // existsSync is true, so the operator must not be told it "does not exist".
    const res = await createApp({ config: seededConfig('corrupt') }).request('/jobs')
    expect(res.status).toBe(503)
    const body = await res.text()
    expect(body).not.toContain('does not exist')
    expect(body).toContain('could not be opened')
  })

  it('logs the underlying error when the database fails to open', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const res = await createApp({ config: seededConfig('corrupt') }).request('/jobs')
      expect(res.status).toBe(503)
      expect(spy).toHaveBeenCalled()
    } finally {
      spy.mockRestore()
    }
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

  it('reports uploads used today with no cap figure', async () => {
    const config = seededConfig()
    const res = await createApp({ config }).request('/publishes')
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toContain('youtube: 0 uploads used today')
  })

  it('shows a backed-off badge after a recent youtube quota failure', async () => {
    // Proves the dashboard reads the same runtime signal the publish loop
    // gates on (quotaBackedOff), rather than a mirrored env-derived cap.
    const config = seededConfig()
    const now = new Date()
    const db = openDb(config.paths.dbPath)
    db.prepare(
      "INSERT INTO jobs (id, channel, tier, topic, status) VALUES ('j1','space','volume','Venus','failed')",
    ).run()
    db.prepare(
      'INSERT INTO publishes (job_id, platform, channel, day, seq, status, attempt, error_kind, created_at) ' +
        "VALUES ('j1','youtube','space','2026-07-25',1,'failed',1,'quota',?)",
    ).run(now.toISOString())
    db.close()
    const res = await createApp({ config, now: () => now }).request('/publishes')
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toContain('backed off')
  })

  it('says so when no channel has an instagram target configured', async () => {
    const config = seededConfig() // channelsDir has no files at all
    mkdirSync(config.paths.channelsDir, { recursive: true })
    const res = await createApp({ config }).request('/publishes')
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toContain('instagram: no channel has a [publish.instagram] target configured')
  })

  it('reports instagram quota per channel — independent usage, not one summed figure', async () => {
    // Instagram's quota is channel-scoped (one IG account per channel): a
    // channel with its own [publish.instagram] table must get its own line,
    // and one channel's usage must never be added into another's.
    const config = seededConfig()
    mkdirSync(config.paths.channelsDir, { recursive: true })
    writeFileSync(
      join(config.paths.channelsDir, 'space.toml'),
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
        '',
        '[publish.instagram]',
        'ig_user_id = "1"',
        '',
      ].join('\n'),
    )
    const now = new Date()
    const today = localDay(now)
    const db = openDb(config.paths.dbPath)
    db.prepare(
      "INSERT INTO jobs (id, channel, tier, topic, status) VALUES ('j1','space','volume','Venus','done')",
    ).run()
    db.prepare(
      'INSERT INTO publishes (job_id, platform, channel, day, seq, status, attempt) ' +
        "VALUES ('j1','instagram','space',?,1,'done',1)",
    ).run(today)
    db.close()

    const res = await createApp({ config, now: () => now }).request('/publishes')
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toContain('space: 1 uploads used today')
  })

  it('backs off only the channel with a recent instagram quota failure, not its sibling', async () => {
    // buildPlatformQuotas passes channel.name into quotaBackedOff for
    // channel-scoped platforms — a call site nothing else here exercises,
    // since the test above only proves independent USAGE counts. Two
    // instagram channels, a quota failure seeded for one of them only: the
    // backed-off badge must appear on that channel's line and nowhere else.
    const config = seededConfig()
    mkdirSync(config.paths.channelsDir, { recursive: true })
    const channelToml = (name: string): string =>
      [
        `name = "${name}"`,
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
        '',
        '[publish.instagram]',
        'ig_user_id = "1"',
        '',
      ].join('\n')
    writeFileSync(join(config.paths.channelsDir, 'space.toml'), channelToml('space'))
    writeFileSync(join(config.paths.channelsDir, 'history.toml'), channelToml('history'))

    const now = new Date()
    const db = openDb(config.paths.dbPath)
    db.prepare(
      "INSERT INTO jobs (id, channel, tier, topic, status) VALUES ('j1','space','volume','Venus','failed')",
    ).run()
    db.prepare(
      'INSERT INTO publishes (job_id, platform, channel, day, seq, status, attempt, error_kind, created_at) ' +
        "VALUES ('j1','instagram','space','2026-07-25',1,'failed',1,'quota',?)",
    ).run(now.toISOString())
    db.close()

    const res = await createApp({ config, now: () => now }).request('/publishes')
    expect(res.status).toBe(200)
    const body = await res.text()
    const spaceLine = /<li>space:[^<]*(?:<[^/][^>]*>[^<]*<\/[^>]*>)?<\/li>/.exec(body)?.[0] ?? ''
    const historyLine =
      /<li>history:[^<]*(?:<[^/][^>]*>[^<]*<\/[^>]*>)?<\/li>/.exec(body)?.[0] ?? ''
    expect(spaceLine).toContain('backed off')
    // Pin the regex actually matched — the '' fallback would satisfy the
    // not.toContain below vacuously.
    expect(historyLine).toContain('history:')
    expect(historyLine).not.toContain('backed off')
  })
})

describe('video streaming', () => {
  function configWithVideo(bytes: Buffer, videoPathInDb?: string): DashboardConfig {
    const paths = resolvePaths(tmpDir('brainrot-vid-'))
    mkdirSync(join(paths.root, 'db'), { recursive: true })
    const videoDir = join(paths.runsRoot, 'j1', 'assemble')
    mkdirSync(videoDir, { recursive: true })
    const videoFile = join(videoDir, 'final.mp4')
    writeFileSync(videoFile, bytes)

    const db = openDb(paths.dbPath)
    db.prepare(
      "INSERT INTO jobs (id, channel, tier, topic, status) VALUES ('j1','space','volume','Venus','done')",
    ).run()
    db.prepare(
      'INSERT INTO library (job_id, video_path, metadata_json, state) VALUES (?, ?, ?, ?)',
    ).run('j1', videoPathInDb ?? videoFile, '{}', 'ready')
    db.close()

    return { paths, port: 8787 }
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
    rmSync(join(config.paths.runsRoot, 'j1', 'assemble', 'final.mp4'))
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

describe('POST /actions', () => {
  const TOKEN = 'test-token'

  function post(config: DashboardConfig, body: Record<string, string | string[]>, headers: Record<string, string> = {}) {
    const form = new URLSearchParams()
    for (const [key, value] of Object.entries(body)) {
      for (const v of Array.isArray(value) ? value : [value]) form.append(key, v)
    }
    return createApp({ config, csrfToken: TOKEN }).request('/actions', {
      method: 'POST',
      body: form,
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        host: '127.0.0.1:8787',
        origin: 'http://127.0.0.1:8787',
        'sec-fetch-site': 'same-origin',
        ...headers,
      },
    })
  }

  it('enqueues a pending row and redirects back', async () => {
    const config = seededConfig()
    const res = await post(config, { kind: 'topics.reject', csrf: TOKEN, ids: '4', from: '/topics' })
    expect(res.status).toBe(303)
    const db = openDb(config.paths.dbPath)
    const rows = db.prepare('SELECT kind, lane, args, status FROM operator_actions').all() as {
      kind: string; lane: string; args: string; status: string
    }[]
    expect(rows).toEqual([
      { kind: 'topics.reject', lane: 'fast', args: '{"ids":[4]}', status: 'pending' },
    ])
    db.close()
  })

  it('redirects to the submitting page carrying the new action id', async () => {
    const res = await post(seededConfig(), { kind: 'topics.reject', csrf: TOKEN, ids: '4', from: '/topics?status=candidate' })
    expect(res.headers.get('location')).toBe('/topics?status=candidate&action=1')
  })

  it('redirects to /actions when the form names no origin page', async () => {
    const res = await post(seededConfig(), { kind: 'digest.run', csrf: TOKEN })
    expect(res.headers.get('location')).toBe('/actions?action=1')
  })

  it('refuses an off-site redirect target', async () => {
    // `from` is operator-controlled; an absolute url would make the dashboard
    // an open redirect.
    const res = await post(seededConfig(), { kind: 'digest.run', csrf: TOKEN, from: 'https://evil.example/x' })
    expect(res.headers.get('location')).toBe('/actions?action=1')
  })

  it('rejects a cross-site submission without writing', async () => {
    const config = seededConfig()
    const res = await post(config, { kind: 'topics.reject', csrf: TOKEN, ids: '4' }, { 'sec-fetch-site': 'cross-site', origin: 'http://evil.example' })
    expect(res.status).toBe(403)
    const db = openDb(config.paths.dbPath)
    expect(db.prepare('SELECT count(*) AS n FROM operator_actions').get()).toEqual({ n: 0 })
    db.close()
  })

  it('escapes an attacker-influenceable header value in the rejection reason', async () => {
    // sec-fetch-site is echoed verbatim into the reason string by csrfFailure
    // and is attacker-controlled on a cross-origin request; the reject page
    // must render it through the escaping `html` template, never raw().
    const res = await post(
      seededConfig(),
      { kind: 'topics.reject', csrf: TOKEN, ids: '4' },
      { 'sec-fetch-site': '<script>alert(1)</script>' },
    )
    expect(res.status).toBe(403)
    const body = await res.text()
    expect(body).not.toContain('<script>alert(1)</script>')
    expect(body).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
  })

  it('rejects a stale token with a reload instruction', async () => {
    const res = await post(seededConfig(), { kind: 'topics.reject', csrf: 'old', ids: '4' })
    expect(res.status).toBe(403)
    expect(await res.text()).toContain('reload the page')
  })

  it('rejects an unknown action kind', async () => {
    const res = await post(seededConfig(), { kind: 'topics.nuke', csrf: TOKEN })
    expect(res.status).toBe(400)
    expect(await res.text()).toContain('unknown action')
  })

  it('rejects invalid arguments with the schema message', async () => {
    const config = seededConfig()
    const res = await post(config, { kind: 'topics.reject', csrf: TOKEN })
    expect(res.status).toBe(400)
    expect(await res.text()).toContain('invalid arguments')
    const db = openDb(config.paths.dbPath)
    expect(db.prepare('SELECT count(*) AS n FROM operator_actions').get()).toEqual({ n: 0 })
    db.close()
  })

  it('groups repeated fields into a list argument', async () => {
    const config = seededConfig()
    await post(config, { kind: 'topics.reject', csrf: TOKEN, ids: ['4', '5'] })
    const db = openDb(config.paths.dbPath)
    expect(db.prepare('SELECT args FROM operator_actions').get()).toEqual({ args: '{"ids":[4,5]}' })
    db.close()
  })

  it('returns 503 instead of 500 when operator_actions has never been created', async () => {
    // A bare sqlite file that no openDb call has ever touched — the commonest
    // real-world cause, since schema.sql (and thus operator_actions) is only
    // applied by openDb/openDbActions' write-path sibling, never by this
    // route's own handle.
    const paths = resolvePaths(tmpDir('brainrot-dash-'))
    mkdirSync(join(paths.root, 'db'), { recursive: true })
    new BetterSqlite3(paths.dbPath).close()
    const config: DashboardConfig = { paths, port: 8787 }

    const res = await post(config, { kind: 'digest.run', csrf: TOKEN })
    expect(res.status).toBe(503)
    expect(await res.text()).toContain('could not queue the action')
  })
})

describe('unbounded list truncation', () => {
  function configWithManyJobs(count: number): DashboardConfig {
    const config = seededConfig()
    const db = openDb(config.paths.dbPath)
    const insert = db.prepare(
      "INSERT INTO jobs (id, channel, tier, topic, status) VALUES (?, 'space', 'volume', 'x', 'done')",
    )
    for (let i = 0; i < count; i++) insert.run(`j${i}`)
    db.close()
    return config
  }

  function configWithManyTopics(count: number): DashboardConfig {
    const config = seededConfig()
    const db = openDb(config.paths.dbPath)
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
    const db = openDb(config.paths.dbPath)
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
