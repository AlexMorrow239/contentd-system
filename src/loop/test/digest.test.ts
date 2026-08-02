import { describe, expect, it, vi } from 'vitest'
import { localDay } from '../../publish/schedule.js'
import { upsertToken } from '../../publish/tokens.js'
import { memDb, seedLibraryObject } from '../../testing/db.js'
import { testChannel } from '../../testing/channel.js'
import { buildDigest, STRANDED_QUEUED_MS, ZOMBIE_RUNNING_MS } from '../digest.js'
import {
  DAY_MS,
  ENV_OK,
  HOUR_MS,
  isoAgo,
  OTHER_KEY_HEX,
  publishChannel,
  scoutingPublishChannel,
  seedCost,
  seedJob,
  seedLibrary,
  seedLibraryPath,
  seedPublish,
  seedStage,
  seedTopic,
  TEST_KEY,
} from './_digest.fixtures.js'

/**
 * The assembled operator digest: pipeline health (topics, jobs, spend,
 * action items, zombie/stranded aging, the failed-job cap, blocked jobs),
 * publishing health (the section body, its action items, ready backlog,
 * volume shortfall), credential/storage health (token status, expiry
 * warnings, unstored objects), and the section order they're assembled in.
 * Shared seeds live in _digest.fixtures.ts.
 */

describe('buildDigest — topics section', () => {
  it('exports the 2h zombie constant', () => {
    expect(ZOMBIE_RUNNING_MS).toBe(7_200_000)
  })

  it('exports the 1h stranded-queued constant', () => {
    expect(STRANDED_QUEUED_MS).toBe(3_600_000)
  })

  it('counts last-24h topics per channel by status, excluding older rows', () => {
    const db = memDb()
    seedTopic(db, { dedupeHash: 'h1', status: 'candidate' })
    seedTopic(db, { dedupeHash: 'h2', status: 'candidate' })
    seedTopic(db, { dedupeHash: 'h3', status: 'claimed', jobId: 'job-1' })
    seedTopic(db, { dedupeHash: 'h4', status: 'rejected' })
    // 3 days old — outside every reading of the 24h window
    seedTopic(db, { dedupeHash: 'h5', createdAt: isoAgo(3 * DAY_MS) })
    seedTopic(db, { channel: 'chan-b', dedupeHash: 'h6', status: 'rejected' })
    const digest = buildDigest(db, [])
    expect(digest).toContain('Topics (last 24h)')
    expect(digest).toContain('  chan-a: 4 scouted — of which 2 candidate, 1 rejected')
    expect(digest).toContain('  chan-b: 1 scouted — of which 0 candidate, 1 rejected')
    db.close()
  })

  it('prints none when no topics were scouted in the last 24h', () => {
    const db = memDb()
    expect(buildDigest(db, [])).toContain('Topics (last 24h)\n  none')
    db.close()
  })
})

describe('buildDigest — jobs section', () => {
  it('counts last-24h jobs per channel with library-resolved outcomes', () => {
    const db = memDb()
    // one ready (done + library row), one failed
    seedJob(db, { id: 'j-ready', status: 'done' })
    seedLibrary(db, 'j-ready', 'ready')
    seedJob(db, { id: 'j-failed', status: 'failed' })
    // one needs-review, one blocked
    seedJob(db, { id: 'j-review', status: 'done' })
    seedLibrary(db, 'j-review', 'needs-review')
    seedJob(db, { id: 'j-blocked', status: 'blocked' })
    // 3 days old — outside the window, not counted here (it will surface in
    // the action-items section, which is current-state, not last-24h)
    seedJob(db, { id: 'j-old', status: 'failed', createdAt: isoAgo(3 * DAY_MS) })
    const digest = buildDigest(db, [])
    expect(digest).toContain('Jobs (last 24h)')
    expect(digest).toContain('  chan-a: 4 — 1 ready, 1 needs-review, 1 failed, 1 blocked')
    db.close()
  })

  it('prints none when no jobs were created in the last 24h', () => {
    const db = memDb()
    expect(buildDigest(db, [])).toContain('Jobs (last 24h)\n  none')
    db.close()
  })
})

describe('buildDigest — spend section', () => {
  it('formats channel and global day spend from integer micros as $X.XX', () => {
    vi.stubEnv('BRAINROT_GLOBAL_DAILY_USD', '10')
    const db = memDb()
    const budget = {
      perVideoUsdMicros: 8_000_000,
      perDayUsdMicros: 20_000_000,
    }
    const chA = testChannel({ name: 'chan-a', budget })
    const chB = testChannel({ name: 'chan-b', budget })
    seedJob(db, { id: 'j-spend', status: 'done' })
    // costs.created_at defaults to now — today's UTC spend by construction.
    // (Only a sub-second UTC-midnight rollover could race this — accepted,
    // same caveat as the costs tests.)
    db.prepare(
      "INSERT INTO costs (job_id, provider, operation, usd_micros) VALUES ('j-spend', 'anthropic', 'script', ?)",
    ).run(1_234_567)
    // Sentinel scout row: no jobs row behind it, so it is invisible to the
    // channel JOIN but counts toward the global sum.
    db.prepare(
      "INSERT INTO costs (job_id, provider, operation, usd_micros) VALUES ('scout:chan-a', 'anthropic', 'scout-score', ?)",
    ).run(20_000)
    const digest = buildDigest(db, [chA, chB])
    expect(digest).toContain('Spend today (UTC)')
    // 1_234_567 micros → $1.23 (toFixed(2)); cap 20_000_000 → $20.00
    expect(digest).toContain('  chan-a: $1.23 of $20.00')
    expect(digest).toContain('  chan-b: $0.00 of $20.00')
    // global: 1_234_567 + 20_000 = 1_254_567 → $1.25 vs the stubbed $10 cap
    expect(digest).toContain('  global: $1.25 of $10.00')
    db.close()
  })
})

describe('buildDigest — action items', () => {
  it('lists failed jobs and flags running jobs older than the zombie threshold', () => {
    const db = memDb()
    seedJob(db, { id: 'j-dead', status: 'failed' })
    // 3h-old running job: past ZOMBIE_RUNNING_MS (2h) — flagged
    seedJob(db, { id: 'j-zombie', status: 'running', createdAt: isoAgo(3 * HOUR_MS) })
    // 1h-old running job: healthy — must NOT be flagged
    seedJob(db, { id: 'j-live', status: 'running', createdAt: isoAgo(HOUR_MS) })
    const digest = buildDigest(db, [])
    expect(digest).toContain('Action items')
    expect(digest).toContain('  failed job j-dead (chan-a) — resume manually')
    expect(digest).toContain(
      '  running job j-zombie (chan-a) running > 2h — probably crashed — resume with --force',
    )
    expect(digest).not.toContain('j-live')
    db.close()
  })

  it('flags a queued job stranded before start and not a freshly claimed one', () => {
    const db = memDb()
    // 2h-old queued: past STRANDED_QUEUED_MS (1h) — crashed before runJob's
    // first status write, invisible to resume/planTick, flagged here.
    seedJob(db, { id: 'j-stranded', status: 'queued', createdAt: isoAgo(2 * HOUR_MS) })
    // just-claimed queued (runJob about to flip it 'running') — must NOT flag.
    seedJob(db, { id: 'j-fresh', status: 'queued', createdAt: isoAgo(0) })
    const digest = buildDigest(db, [])
    expect(digest).toContain(
      '  queued job j-stranded (chan-a) — stranded before start — resume with brainrot resume j-stranded',
    )
    expect(digest).not.toContain('j-fresh')
    db.close()
  })

  it('prints none when there are no action items', () => {
    const db = memDb()
    expect(buildDigest(db, [])).toContain('Action items\n  none')
    db.close()
  })

  // The caller (the digest command) hands the load failure down instead of
  // aborting: the sqlite sections are still worth printing, and a report that
  // silently omits every channel-derived section reads as "all clear".
  it('names a channels-dir load failure as the first action item, above the db-derived ones', () => {
    const db = memDb()
    seedJob(db, { id: 'j-failed', status: 'failed' })
    const digest = buildDigest(
      db,
      [],
      {},
      { channelsError: 'failed to load channel config a.toml: bad' },
    )
    expect(digest).toContain(
      'Action items\n  the channels dir did not load (failed to load channel config a.toml: bad) — spend, publishing, and channel-derived action items are missing from this report',
    )
    // and it never displaces the sqlite-derived items
    expect(digest).toContain('  failed job j-failed (chan-a) — resume manually')
    db.close()
  })

  it('the config-error line suppresses the none placeholder', () => {
    const db = memDb()
    const digest = buildDigest(db, [], {}, { channelsError: 'ENOENT: no such file or directory' })
    expect(digest).not.toContain('Action items\n  none')
    db.close()
  })
})

describe('buildDigest — zombie age comes from the latest stage start', () => {
  it('does not flag an old job whose latest stage started minutes ago', () => {
    const db = memDb()
    // Created yesterday, blocked, auto-resumed 5 minutes ago: aging by
    // created_at alone would print "resume with --force" over a live render.
    seedJob(db, { id: 'j-resumed', status: 'running', createdAt: isoAgo(10 * HOUR_MS) })
    seedStage(db, 'j-resumed', 'script', isoAgo(10 * HOUR_MS))
    seedStage(db, 'j-resumed', 'visuals', isoAgo(5 * 60_000))
    const digest = buildDigest(db, [], ENV_OK)
    expect(digest).not.toContain('j-resumed')
    db.close()
  })

  it('flags a running job whose latest stage started before the zombie threshold', () => {
    const db = memDb()
    seedJob(db, { id: 'j-stuck', status: 'running', createdAt: isoAgo(10 * HOUR_MS) })
    seedStage(db, 'j-stuck', 'script', isoAgo(4 * HOUR_MS))
    seedStage(db, 'j-stuck', 'visuals', isoAgo(3 * HOUR_MS))
    const digest = buildDigest(db, [], ENV_OK)
    expect(digest).toContain(
      '  running job j-stuck (chan-a) running > 2h — probably crashed — resume with --force',
    )
    db.close()
  })

  it('still ages a stageless running job by created_at', () => {
    const db = memDb()
    seedJob(db, { id: 'j-nostage', status: 'running', createdAt: isoAgo(3 * HOUR_MS) })
    const digest = buildDigest(db, [], ENV_OK)
    expect(digest).toContain('  running job j-nostage (chan-a) running > 2h')
    db.close()
  })
})

describe('buildDigest — failed-job list cap', () => {
  it('lists the 10 most recent failures and counts the rest in one line', () => {
    const db = memDb()
    for (let i = 0; i < 13; i++) {
      // i = 0 is the oldest; the three oldest fall past the cap.
      seedJob(db, { id: `j-f${i}`, status: 'failed', createdAt: isoAgo((13 - i) * HOUR_MS) })
    }
    const digest = buildDigest(db, [], ENV_OK)
    expect(digest).toContain('  failed job j-f12 (chan-a) — resume manually')
    expect(digest).toContain('  failed job j-f3 (chan-a) — resume manually')
    expect(digest).not.toContain('j-f2 ')
    expect(digest).not.toContain('j-f0 ')
    expect(digest).toContain('  and 3 older failures')
    // Oldest-first within the kept window, unchanged from the uncapped list.
    expect(digest.indexOf('j-f3')).toBeLessThan(digest.indexOf('j-f12'))
    db.close()
  })

  it('adds no truncation line at or below the cap', () => {
    const db = memDb()
    for (let i = 0; i < 10; i++) {
      seedJob(db, { id: `j-f${i}`, status: 'failed', createdAt: isoAgo((10 - i) * HOUR_MS) })
    }
    const digest = buildDigest(db, [], ENV_OK)
    expect(digest).toContain('  failed job j-f0 (chan-a) — resume manually')
    expect(digest).not.toContain('older failures')
    db.close()
  })
})

describe('buildDigest — blocked jobs that cannot resume', () => {
  // Remedies must name commands that exist: there is no way to "reject" a
  // blocked job (library reject only touches library rows, which a blocked
  // job never has), so these lines name `resume` and, when the job still
  // holds a topic, `topics requeue`.
  it('names a blocked job whose channel config left the channels dir', () => {
    const db = memDb()
    seedJob(db, { id: 'j-orphan', channel: 'gone', status: 'blocked' })
    const digest = buildDigest(db, [], ENV_OK)
    expect(digest).toContain(
      '  blocked job j-orphan (gone) — no channel config named gone in the channels dir — restore gone.toml then brainrot resume j-orphan',
    )
    // No claimed topic behind this job, so no requeue clause is offered.
    expect(digest).not.toContain('topics requeue')
    db.close()
  })

  it('points at the concrete topic a blocked job still holds', () => {
    const db = memDb()
    seedJob(db, { id: 'j-orphan', channel: 'gone', status: 'blocked' })
    const topicId = seedTopic(db, {
      dedupeHash: 'h-held',
      channel: 'gone',
      status: 'claimed',
      jobId: 'j-orphan',
    })
    const digest = buildDigest(db, [], ENV_OK)
    expect(digest).toContain(
      `restore gone.toml then brainrot resume j-orphan, or free its topic with brainrot topics requeue ${topicId}`,
    )
    db.close()
  })

  it('names an exhausted per-video cap', () => {
    const db = memDb()
    seedJob(db, { id: 'j-spent', channel: 'chan-a', status: 'blocked' })
    // testChannel's per-video cap is $8.00.
    seedCost(db, 'j-spent', 8_000_000)
    const digest = buildDigest(db, [testChannel({ name: 'chan-a' })], ENV_OK)
    expect(digest).toContain(
      '  blocked job j-spent (chan-a) — per-video budget spent ($8.00 of $8.00) — raise the cap in chan-a.toml then brainrot resume j-spent',
    )
    db.close()
  })

  it('reports remaining headroom for a blocked job that can still resume', () => {
    const db = memDb()
    seedJob(db, { id: 'j-wait', channel: 'chan-a', status: 'blocked' })
    seedCost(db, 'j-wait', 2_000_000)
    const digest = buildDigest(db, [testChannel({ name: 'chan-a' })], ENV_OK)
    // per-video cap is $8.00 in testChannel.
    expect(digest).toContain(
      '  blocked job j-wait (chan-a) — $6.00 of its $8.00 per-video budget left — awaiting the resume pass',
    )
    db.close()
  })
})

describe('buildDigest — publishing section', () => {
  it('lists a published video with its resolved title and url', () => {
    const db = memDb()
    seedJob(db, { id: 'j-pub', channel: 'chan-a' })
    db.prepare(
      "INSERT INTO library (job_id, video_path, metadata_json, state) VALUES (?, '/tmp/out.mp4', ?, 'published')",
    ).run(
      'j-pub',
      JSON.stringify({ youtube: { title: 'Moon Facts', description: 'd', hashtags: [] } }),
    )
    seedPublish(db, {
      jobId: 'j-pub',
      channel: 'chan-a',
      seq: 1,
      status: 'done',
      url: 'https://youtube.com/shorts/abc123',
    })
    const digest = buildDigest(db, [])
    expect(digest).toContain('Publishing (last 24h)')
    expect(digest).toContain('  Published:')
    expect(digest).toContain('    chan-a #1 "Moon Facts" — https://youtube.com/shorts/abc123')
    db.close()
  })

  it('lists a failed attempt with its error kind and truncates the error to 80 chars', () => {
    const db = memDb()
    const longError = 'x'.repeat(120)
    seedPublish(db, {
      jobId: 'j-fail',
      channel: 'chan-b',
      seq: 2,
      status: 'failed',
      errorKind: 'rejected',
      error: longError,
    })
    const digest = buildDigest(db, [])
    expect(digest).toContain(`    chan-b #2 rejected: ${'x'.repeat(80)}`)
    expect(digest).not.toContain('x'.repeat(81))
    db.close()
  })

  it('prints none for both subsections when nothing published or failed in the last 24h', () => {
    const db = memDb()
    const digest = buildDigest(db, [])
    expect(digest).toContain('  Published:\n    none')
    expect(digest).toContain('  Failed:\n    none')
    db.close()
  })

  it('excludes publishes older than 24h', () => {
    const db = memDb()
    seedJob(db, { id: 'j-old', channel: 'chan-a' })
    db.prepare(
      "INSERT INTO library (job_id, video_path, metadata_json, state) VALUES ('j-old', '/tmp/out.mp4', '{}', 'published')",
    ).run()
    seedPublish(db, {
      jobId: 'j-old',
      channel: 'chan-a',
      status: 'done',
      url: 'https://youtube.com/shorts/old',
      createdAt: isoAgo(3 * DAY_MS),
    })
    const digest = buildDigest(db, [])
    expect(digest).toContain('  Published:\n    none')
    db.close()
  })
})

describe('buildDigest — publishing action items', () => {
  it('flags channels with auth failures in the last 24h, one line per channel', () => {
    const db = memDb()
    seedPublish(db, {
      jobId: 'j1',
      channel: 'chan-a',
      seq: 1,
      status: 'failed',
      errorKind: 'auth',
    })
    seedPublish(db, {
      jobId: 'j2',
      channel: 'chan-a',
      seq: 2,
      status: 'failed',
      errorKind: 'auth',
    })
    const digest = buildDigest(db, [])
    expect(digest).toContain(
      '  chan-a youtube: 2 auth failures in the last 24h — run brainrot auth youtube --channel chan-a',
    )
    db.close()
  })

  it('flags quota failures distinctly — awareness, since the tick backs off and retries by itself', () => {
    const db = memDb()
    seedPublish(db, {
      jobId: 'j1',
      channel: 'chan-a',
      seq: 1,
      status: 'failed',
      errorKind: 'quota',
    })
    seedPublish(db, {
      jobId: 'j2',
      channel: 'chan-a',
      seq: 2,
      status: 'failed',
      errorKind: 'quota',
    })
    const digest = buildDigest(db, [])
    expect(digest).toContain(
      '  chan-a youtube: 2 quota failures in the last 24h — platform reported quota exhaustion; uploads back off 6h per failure and retry automatically',
    )
    db.close()
  })

  it('instructs checking Studio for interrupted uploads of any age', () => {
    const db = memDb()
    seedPublish(db, {
      jobId: 'j-int',
      channel: 'chan-a',
      seq: 3,
      status: 'interrupted',
      createdAt: isoAgo(3 * DAY_MS),
    })
    const digest = buildDigest(db, [])
    expect(digest).toContain(
      '  interrupted publish j-int (chan-a, youtube, #3) — check YouTube Studio, then brainrot publish retry j-int or brainrot publish mark-done j-int <postId>',
    )
    db.close()
  })

  it('suggests library reject for a job at the rejected attempt cap while still ready', () => {
    const db = memDb()
    seedJob(db, { id: 'j-capped', channel: 'chan-a' })
    seedLibrary(db, 'j-capped', 'ready')
    seedPublish(db, {
      jobId: 'j-capped',
      channel: 'chan-a',
      day: '2026-07-19',
      seq: 1,
      status: 'failed',
      errorKind: 'rejected',
    })
    seedPublish(db, {
      jobId: 'j-capped',
      channel: 'chan-a',
      day: '2026-07-19',
      seq: 2,
      status: 'failed',
      errorKind: 'rejected',
    })
    seedPublish(db, {
      jobId: 'j-capped',
      channel: 'chan-a',
      day: '2026-07-19',
      seq: 3,
      status: 'failed',
      errorKind: 'rejected',
    })
    const digest = buildDigest(db, [])
    expect(digest).toContain(
      '  job j-capped (chan-a) hit the publish attempt cap (3 rejected) — run brainrot library reject j-capped',
    )
    db.close()
  })

  it('does not flag a job under the attempt cap', () => {
    const db = memDb()
    seedJob(db, { id: 'j-under', channel: 'chan-a' })
    seedLibrary(db, 'j-under', 'ready')
    seedPublish(db, {
      jobId: 'j-under',
      channel: 'chan-a',
      day: '2026-07-19',
      seq: 1,
      status: 'failed',
      errorKind: 'rejected',
    })
    seedPublish(db, {
      jobId: 'j-under',
      channel: 'chan-a',
      day: '2026-07-19',
      seq: 2,
      status: 'failed',
      errorKind: 'rejected',
    })
    const digest = buildDigest(db, [])
    expect(digest).not.toContain('publish attempt cap')
    db.close()
  })
})

describe('buildDigest — ready-backlog in the Publishing section', () => {
  it('reports ready backlog depth and oldest age inside Publishing (not Action items), publishing channels only', () => {
    const db = memDb()
    const chA = testChannel({
      name: 'chan-a',
      platforms: ['youtube'],
    })
    const chB = testChannel({ name: 'chan-b', platforms: [] })
    seedJob(db, { id: 'j-old', channel: 'chan-a' })
    seedLibrary(db, 'j-old', 'ready', isoAgo(5 * HOUR_MS))
    seedJob(db, { id: 'j-new', channel: 'chan-a' })
    seedLibrary(db, 'j-new', 'ready', isoAgo(HOUR_MS))
    seedJob(db, { id: 'j-nopublish', channel: 'chan-b' })
    seedLibrary(db, 'j-nopublish', 'ready')
    const digest = buildDigest(db, [chA, chB])
    expect(digest).toContain('  Backlog:')
    const backlogLine = '    chan-a: 2 ready videos backlogged, oldest 5h old'
    expect(digest).toContain(backlogLine)
    expect(digest).not.toContain('chan-b: 1 ready videos backlogged')
    // The backlog line lives in Publishing (last 24h), before Action items —
    // never under Action items where a lone ready video would stand daily.
    const backlogIdx = digest.indexOf(backlogLine)
    expect(backlogIdx).toBeGreaterThan(digest.indexOf('Publishing (last 24h)'))
    expect(backlogIdx).toBeLessThan(digest.indexOf('Action items'))
    db.close()
  })

  it('labels the backlog subsection and falls back to none when no channel has a ready backlog', () => {
    const db = memDb()
    const digest = buildDigest(db, [])
    expect(digest).toContain('  Backlog:\n    none')
    db.close()
  })
})

describe('buildDigest — volume-shortfall action item', () => {
  it('reports a channel that published fewer videos than videos_per_day yesterday, split per platform', () => {
    const db = memDb()
    // Mirror the impl's own local field math (new Date(now); setDate(-1);
    // localDay) — now-minus-24h lands on the wrong local date across a DST
    // transition and would diverge from the digest in that window.
    const yesterdayDate = new Date()
    yesterdayDate.setDate(yesterdayDate.getDate() - 1)
    const yesterday = localDay(yesterdayDate)
    const chA = testChannel({
      name: 'chan-a',
      videosPerDay: 3,
      // Declared instagram-first: the per-platform split follows declaration
      // order.
      platforms: ['instagram', 'youtube'],
    })
    seedJob(db, { id: 'j-yday', channel: 'chan-a' })
    seedPublish(db, {
      jobId: 'j-yday',
      channel: 'chan-a',
      day: yesterday,
      seq: 1,
      status: 'done',
    })
    const digest = buildDigest(db, [chA])
    expect(digest).toContain(
      `  chan-a: published 1 of 3 videos yesterday (${yesterday}) — instagram 0, youtube 1`,
    )
    db.close()
  })

  it('says nothing when the channel met its count', () => {
    const db = memDb()
    const yesterdayDate = new Date()
    yesterdayDate.setDate(yesterdayDate.getDate() - 1)
    const yesterday = localDay(yesterdayDate)
    const chA = publishChannel('chan-a', { videosPerDay: 1 })
    seedJob(db, { id: 'j-yday', channel: 'chan-a' })
    seedPublish(db, {
      jobId: 'j-yday',
      channel: 'chan-a',
      day: yesterday,
      seq: 1,
      status: 'done',
    })
    const digest = buildDigest(db, [chA])
    expect(digest).not.toContain('videos yesterday')
    db.close()
  })

  it('does not report a shortfall for a channel with no publish config', () => {
    const db = memDb()
    const chB = testChannel({ name: 'chan-b', platforms: [] })
    const digest = buildDigest(db, [chB])
    expect(digest).not.toContain('videos yesterday')
    db.close()
  })

  // The channel-level gate (`published >= videosPerDay`) only sees DISTINCT
  // jobs across ALL platforms, so a channel that clears its count entirely on
  // one platform's back stays silent even when another declared platform
  // uploaded nothing all day — exactly the "YouTube publishes zero for a
  // week" case that must not be invisible on a multi-platform channel.
  it('flags a channel that met its count but got zero uploads on one declared platform', () => {
    const db = memDb()
    const yesterdayDate = new Date()
    yesterdayDate.setDate(yesterdayDate.getDate() - 1)
    const yesterday = localDay(yesterdayDate)
    const chA = testChannel({
      name: 'chan-a',
      videosPerDay: 1,
      platforms: ['instagram', 'youtube'],
    })
    seedJob(db, { id: 'j-yday', channel: 'chan-a' })
    // Only instagram published; the channel count (1 of 1) is met purely on
    // instagram's back — the old gate would stay silent about youtube.
    seedPublish(db, {
      jobId: 'j-yday',
      channel: 'chan-a',
      platform: 'instagram',
      day: yesterday,
      seq: 1,
      status: 'done',
    })
    const digest = buildDigest(db, [chA])
    expect(digest).toContain(
      '  chan-a youtube: 0 uploads yesterday while the channel published 1 — platform may be dead (auth/quota), not merely oversubscribed',
    )
    db.close()
  })

  // QUOTA_BACKOFF_MS is 6h, so a quota-jammed platform still writes 3-4
  // claimed->failed/quota rows across a day's backoff-window openings — it is
  // never truly "0 rows that day". The zero-test must count successes
  // (status = 'done'), not attempts of any status, or this is exactly the
  // scenario the line was written for (mvp's shape: Instagram healthy,
  // YouTube quota-dead) and it never fires.
  it('flags a dead platform whose only rows that day are quota-failed attempts, not zero rows', () => {
    const db = memDb()
    const yesterdayDate = new Date()
    yesterdayDate.setDate(yesterdayDate.getDate() - 1)
    const yesterday = localDay(yesterdayDate)
    const chA = testChannel({
      name: 'chan-a',
      videosPerDay: 1,
      platforms: ['instagram', 'youtube'],
    })
    seedJob(db, { id: 'j-yday', channel: 'chan-a' })
    seedPublish(db, {
      jobId: 'j-yday',
      channel: 'chan-a',
      platform: 'instagram',
      day: yesterday,
      seq: 1,
      status: 'done',
    })
    // youtube was attempted (and rejected by its own quota error) but never
    // succeeded that day — a COUNT(DISTINCT job_id) with no status filter
    // reads this as "1", not "0".
    seedPublish(db, {
      jobId: 'j-yday',
      channel: 'chan-a',
      platform: 'youtube',
      day: yesterday,
      seq: 1,
      status: 'failed',
      errorKind: 'quota',
    })
    const digest = buildDigest(db, [chA])
    expect(digest).toContain(
      '  chan-a youtube: 0 uploads yesterday while the channel published 1 — platform may be dead (auth/quota), not merely oversubscribed',
    )
    db.close()
  })

  it('says nothing when every declared platform published at least one video and the count is met', () => {
    const db = memDb()
    const yesterdayDate = new Date()
    yesterdayDate.setDate(yesterdayDate.getDate() - 1)
    const yesterday = localDay(yesterdayDate)
    const chA = testChannel({
      name: 'chan-a',
      videosPerDay: 1,
      platforms: ['instagram', 'youtube'],
    })
    seedJob(db, { id: 'j-yday', channel: 'chan-a' })
    seedPublish(db, {
      jobId: 'j-yday',
      channel: 'chan-a',
      platform: 'instagram',
      day: yesterday,
      seq: 1,
      status: 'done',
    })
    seedPublish(db, {
      jobId: 'j-yday',
      channel: 'chan-a',
      platform: 'youtube',
      day: yesterday,
      seq: 1,
      status: 'done',
    })
    const digest = buildDigest(db, [chA])
    expect(digest).not.toContain('videos yesterday')
    expect(digest).not.toContain('may be dead')
    db.close()
  })
})

describe('buildDigest — publish token health', () => {
  it('tells the operator to authorize a publish-enabled channel with no stored token', () => {
    const db = memDb()
    const digest = buildDigest(db, [publishChannel('chan-a')], ENV_OK)
    expect(digest).toContain(
      '  chan-a youtube: no stored token — run brainrot auth youtube --channel chan-a',
    )
    db.close()
  })

  it('names the key rotation when a stored token no longer decrypts', () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
    const db = memDb()
    upsertToken(db, 'youtube', 'chan-a', 'rt-test-token', 'scope', TEST_KEY)
    const digest = buildDigest(db, [publishChannel('chan-a')], {
      ...ENV_OK,
      tokenKeyHex: OTHER_KEY_HEX,
    })
    expect(digest).toContain(
      '  chan-a youtube: the stored token does not decrypt with the current BRAINROT_TOKEN_KEY — run brainrot auth youtube --channel chan-a',
    )
    db.close()
    stderr.mockRestore()
  })

  it('says nothing about tokens when the grant is healthy', () => {
    const db = memDb()
    upsertToken(db, 'youtube', 'chan-a', 'rt-test-token', 'scope', TEST_KEY)
    const digest = buildDigest(db, [publishChannel('chan-a')], ENV_OK)
    expect(digest).not.toContain('chan-a youtube: no stored token')
    expect(digest).not.toContain('does not decrypt')
    db.close()
  })

  it('lists the unset publish env vars once, by name', () => {
    const db = memDb()
    upsertToken(db, 'youtube', 'chan-a', 'rt-test-token', 'scope', TEST_KEY)
    const digest = buildDigest(db, [publishChannel('chan-a'), publishChannel('chan-b')], {
      ytClientIdPresent: false,
      ytClientSecretPresent: true,
      tokenKeyHex: undefined,
    })
    expect(digest).toContain(
      '  publishing is not configured: YT_CLIENT_ID, BRAINROT_TOKEN_KEY unset — every publish tick noops with reason no-auth',
    )
    // One line for the whole run, not one per channel.
    expect(digest.split('publishing is not configured').length).toBe(2)
    db.close()
  })

  it('flags a BRAINROT_TOKEN_KEY that is set but malformed without echoing it', () => {
    const db = memDb()
    const digest = buildDigest(db, [publishChannel('chan-a')], { ...ENV_OK, tokenKeyHex: 'nothex' })
    expect(digest).toContain(
      '  BRAINROT_TOKEN_KEY is set but is not 64 hex characters — stored tokens cannot be decrypted',
    )
    expect(digest).not.toContain('nothex')
    db.close()
  })

  it('checks no tokens for a channel without a publish config', () => {
    const db = memDb()
    const digest = buildDigest(db, [testChannel({ name: 'chan-b', platforms: [] })], ENV_OK)
    expect(digest).not.toContain('no stored token')
    expect(digest).not.toContain('publishing is not configured')
    db.close()
  })
})

describe('buildDigest — token expiry warning', () => {
  // buildDigest reads its own clock (new Date()), so these seed expiries
  // relative to Date.now() rather than an injected `now`.
  function instagramChannel(name: string) {
    return testChannel({
      name,
      platforms: ['instagram'],
    })
  }

  it('warns when a stored token expires within the 3-day window', () => {
    const db = memDb()
    const channel = instagramChannel('chan-a')
    const soonExpiry = new Date(Date.now() + 2 * DAY_MS).toISOString()
    upsertToken(db, 'instagram', 'chan-a', 'tok', 'scope', TEST_KEY, soonExpiry)
    const digest = buildDigest(db, [channel], ENV_OK)
    expect(digest).toContain(`  chan-a instagram: stored token expires ${soonExpiry}`)
    db.close()
  })

  it('does not warn when expiry is far out', () => {
    const db = memDb()
    const channel = instagramChannel('chan-a')
    const farExpiry = new Date(Date.now() + 30 * DAY_MS).toISOString()
    upsertToken(db, 'instagram', 'chan-a', 'tok', 'scope', TEST_KEY, farExpiry)
    const digest = buildDigest(db, [channel], ENV_OK)
    expect(digest).not.toContain('stored token expires')
    db.close()
  })

  it('never warns for a null expiry (youtube)', () => {
    const db = memDb()
    const channel = publishChannel('chan-a')
    upsertToken(db, 'youtube', 'chan-a', 'rt', 'scope', TEST_KEY)
    const digest = buildDigest(db, [channel], ENV_OK)
    expect(digest).not.toContain('stored token expires')
    db.close()
  })
})

describe('buildDigest — library rows with no stored object', () => {
  it('flags a ready library row that has no library_objects row', () => {
    const db = memDb()
    seedJob(db, { id: 'j-unstored', channel: 'chan-a' })
    seedLibrary(db, 'j-unstored', 'ready')
    const digest = buildDigest(db, [], ENV_OK)
    expect(digest).toContain(
      '  job j-unstored (chan-a) has no stored object — run brainrot library backfill-store',
    )
    db.close()
  })

  it('does not flag a row whose local file is gone but is stored', () => {
    const db = memDb()
    seedJob(db, { id: 'j-stored', channel: 'chan-a' })
    seedLibraryPath(db, 'j-stored', '/nonexistent/runs/j-stored/final.mp4')
    db.prepare(
      "INSERT INTO library_objects (job_id, object_key, bytes, etag) VALUES ('j-stored','k',1,'e')",
    ).run()
    const digest = buildDigest(db, [], ENV_OK)
    expect(digest).not.toContain('j-stored')
    db.close()
  })

  // This line names `backfill-store`, so it must report exactly what that
  // command uploads — both now read unstoredLibraryJobs (src/jobs/library.ts).
  // A needs-review row is in scope for both: approving it promotes it straight
  // into the publish pool, where a missing object is an Instagram failure.
  it('flags a needs-review library row with no stored object', () => {
    const db = memDb()
    seedJob(db, { id: 'j-review', channel: 'chan-a' })
    db.prepare(
      "INSERT INTO library (job_id, video_path, metadata_json, state) VALUES ('j-review', '/nonexistent/final.mp4', '{}', 'needs-review')",
    ).run()
    const digest = buildDigest(db, [], ENV_OK)
    expect(digest).toContain(
      '  job j-review (chan-a) has no stored object — run brainrot library backfill-store',
    )
    db.close()
  })

  // The one excluded state: `library reject` deletes the object on purpose
  // (design spec decision 7), so a blocked row is not missing an upload —
  // reporting it would invite the operator to resurrect what they discarded.
  it('ignores blocked library rows, whose object was deliberately deleted', () => {
    const db = memDb()
    seedJob(db, { id: 'j-blocked', channel: 'chan-a' })
    db.prepare(
      "INSERT INTO library (job_id, video_path, metadata_json, state) VALUES ('j-blocked', '/nonexistent/final.mp4', '{}', 'blocked')",
    ).run()
    const digest = buildDigest(db, [], ENV_OK)
    expect(digest).not.toContain('j-blocked')
    db.close()
  })

  // A row already 'published' on one target can still be eligible for
  // another target (multi-platform publishing) — it still needs an object
  // in the bucket just as much as a plain 'ready' row does.
  it('flags a published library row with no stored object', () => {
    const db = memDb()
    seedJob(db, { id: 'j-published', channel: 'chan-a' })
    db.prepare(
      "INSERT INTO library (job_id, video_path, metadata_json, state) VALUES ('j-published', '/nonexistent/final.mp4', '{}', 'published')",
    ).run()
    const digest = buildDigest(db, [], ENV_OK)
    expect(digest).toContain(
      '  job j-published (chan-a) has no stored object — run brainrot library backfill-store',
    )
    db.close()
  })
})

describe('buildDigest — aged-out videos in the Publishing section', () => {
  it('reports videos that aged out unpublished on a declared platform', () => {
    const db = memDb()
    const channel = testChannel({
      name: 'chan-a',
      backlogDays: 2,
      platforms: ['youtube'],
    })
    seedJob(db, { id: 'job-1', channel: 'chan-a' })
    db.prepare(
      "INSERT INTO library (job_id, video_path, metadata_json, state, created_at) VALUES ('job-1', '/tmp/out.mp4', '{}', 'published', ?)",
    ).run(isoAgo(72 * HOUR_MS))
    seedPublish(db, {
      jobId: 'job-1',
      channel: 'chan-a',
      platform: 'instagram',
      status: 'done',
      seq: 1,
    })
    // Aged out means OUTRANKED WHILE WAITING, so another job must have
    // published inside job-1's grace window — after job-1 was produced (72h
    // ago) and no later than the horizon (backlog_days = 2, so 48h ago).
    // job-2 has no library row, so it supplies the evidence without being
    // reported itself.
    seedJob(db, { id: 'job-2', channel: 'chan-a' })
    seedPublish(db, {
      jobId: 'job-2',
      channel: 'chan-a',
      platform: 'instagram',
      status: 'done',
      seq: 2,
      createdAt: isoAgo(60 * HOUR_MS),
    })
    const digest = buildDigest(db, [channel], { tokenKeyHex: undefined })
    expect(digest).toContain('chan-a: 1 video aged out unpublished on youtube')
    db.close()
  })

  it('reports none while nothing has outranked the old videos', () => {
    // A publish outage longer than backlog_days is not a wave of passed-over
    // videos: every one of them is still publishable.
    const db = memDb()
    const channel = testChannel({
      name: 'chan-a',
      backlogDays: 2,
      platforms: ['youtube'],
    })
    seedJob(db, { id: 'job-1', channel: 'chan-a' })
    seedLibrary(db, 'job-1', 'ready', isoAgo(72 * HOUR_MS))
    const digest = buildDigest(db, [channel], { tokenKeyHex: undefined })
    expect(digest).toContain('  Aged out:\n    none')
    db.close()
  })

  it('reports none when the only later publish landed after the horizon', () => {
    // The recovering outage: one publish once credentials are fixed is not
    // evidence that the backlog behind it was passed over, so the section must
    // stay silent rather than announce a wave of write-offs.
    const db = memDb()
    const channel = testChannel({
      name: 'chan-a',
      backlogDays: 2,
      platforms: ['youtube'],
    })
    seedJob(db, { id: 'job-1', channel: 'chan-a' })
    seedLibrary(db, 'job-1', 'ready', isoAgo(72 * HOUR_MS))
    seedJob(db, { id: 'job-2', channel: 'chan-a' })
    seedPublish(db, {
      jobId: 'job-2',
      channel: 'chan-a',
      platform: 'instagram',
      status: 'done',
      seq: 1,
      createdAt: isoAgo(HOUR_MS),
    })
    const digest = buildDigest(db, [channel], { tokenKeyHex: undefined })
    expect(digest).toContain('  Aged out:\n    none')
    db.close()
  })

  it('still reports at a backlog_days the old fixed 7-day window made unreachable', () => {
    // windowStart used to be `now - 7 days` regardless of backlog_days, so at
    // backlog_days >= 7 the reported range was empty or inverted and the
    // section was permanently silent. backlog_days has no upper bound.
    const db = memDb()
    const channel = testChannel({
      name: 'chan-a',
      backlogDays: 10,
      platforms: ['youtube'],
    })
    seedJob(db, { id: 'job-1', channel: 'chan-a' })
    db.prepare(
      "INSERT INTO library (job_id, video_path, metadata_json, state, created_at) VALUES ('job-1', '/tmp/out.mp4', '{}', 'published', ?)",
    ).run(isoAgo(12 * 24 * HOUR_MS))
    seedPublish(db, {
      jobId: 'job-1',
      channel: 'chan-a',
      platform: 'instagram',
      status: 'done',
      seq: 1,
      createdAt: isoAgo(11 * 24 * HOUR_MS),
    })
    seedJob(db, { id: 'job-2', channel: 'chan-a' })
    seedPublish(db, {
      jobId: 'job-2',
      channel: 'chan-a',
      platform: 'instagram',
      status: 'done',
      seq: 2,
      // Inside job-1's window: after it was produced (12 days ago) and no
      // later than the horizon (backlog_days = 10).
      createdAt: isoAgo(11 * 24 * HOUR_MS),
    })

    const digest = buildDigest(db, [channel], { tokenKeyHex: undefined })
    expect(digest).toContain('chan-a: 1 video aged out unpublished on youtube')
    db.close()
  })

  it('reports none when every aged video published everywhere', () => {
    const db = memDb()
    const channel = testChannel({
      name: 'chan-a',
      backlogDays: 2,
      platforms: ['youtube'],
    })
    seedJob(db, { id: 'job-1', channel: 'chan-a' })
    db.prepare(
      "INSERT INTO library (job_id, video_path, metadata_json, state, created_at) VALUES ('job-1', '/tmp/out.mp4', '{}', 'published', ?)",
    ).run(isoAgo(72 * HOUR_MS))
    seedPublish(db, {
      jobId: 'job-1',
      channel: 'chan-a',
      platform: 'youtube',
      status: 'done',
      seq: 1,
    })
    const digest = buildDigest(db, [channel], { tokenKeyHex: undefined })
    expect(digest).toContain('  Aged out:\n    none')
    db.close()
  })

  it('does not report a video that is still inside its horizon', () => {
    const db = memDb()
    const channel = testChannel({
      name: 'chan-a',
      backlogDays: 2,
      platforms: ['youtube'],
    })
    seedJob(db, { id: 'job-1', channel: 'chan-a' })
    seedLibrary(db, 'job-1', 'ready', isoAgo(HOUR_MS))
    const digest = buildDigest(db, [channel], { tokenKeyHex: undefined })
    expect(digest).toContain('  Aged out:\n    none')
    db.close()
  })
})

describe('buildDigest — reclaimed but unreviewed videos', () => {
  it('names a needs-review video whose bytes were freed, with the reject remedy', () => {
    // The accepted consequence of not exempting needs-review from the reclaim
    // sweep: nobody reviewed it inside backlog_days, so its object is gone.
    // `library approve` refuses it, so this line is the only way an operator
    // learns the row is dead weight.
    const db = memDb()
    seedJob(db, { id: 'job-1', channel: 'chan-a' })
    seedLibrary(db, 'job-1', 'needs-review')
    seedLibraryObject(db, 'job-1', { reclaimedAt: isoAgo(HOUR_MS) })

    expect(buildDigest(db, [], ENV_OK)).toContain(
      'job job-1 (chan-a) is still needs-review but its stored object was reclaimed',
    )
    db.close()
  })

  it('says nothing about a needs-review video whose object is still held', () => {
    const db = memDb()
    seedJob(db, { id: 'job-1', channel: 'chan-a' })
    seedLibrary(db, 'job-1', 'needs-review')
    seedLibraryObject(db, 'job-1')

    expect(buildDigest(db, [], ENV_OK)).not.toContain('its stored object was reclaimed')
    db.close()
  })
})

describe('buildDigest — channels at their backlog cap', () => {
  it('names a publishing channel whose production has halted, with inventory and cap', () => {
    // videos_per_day 2 x backlog_days 2 = a cap of 4. Nothing else in the
    // digest shows this: the Backlog subsection counts only 'ready' rows and
    // the Jobs section is windowed to 24h, so a halted channel just vanishes.
    const db = memDb()
    for (let i = 1; i <= 4; i++) {
      seedJob(db, { id: `job-${i}`, channel: 'chan-a' })
      seedLibrary(db, `job-${i}`, 'ready', isoAgo(HOUR_MS))
    }

    expect(buildDigest(db, [publishChannel('chan-a')], ENV_OK)).toContain(
      'chan-a: holding 4 of 4 finished videos (backlog_days 2 x videos_per_day 2) — production is paused until these publish or are rejected',
    )
    db.close()
  })

  it('names a channel with no [publish] table too — nothing drains it', () => {
    const db = memDb()
    for (let i = 1; i <= 4; i++) {
      seedJob(db, { id: `job-${i}`, channel: 'chan-a' })
      seedLibrary(db, `job-${i}`, 'ready', isoAgo(HOUR_MS))
    }

    expect(buildDigest(db, [testChannel({ name: 'chan-a' })], ENV_OK)).toContain(
      'chan-a: holding 4 of 4 finished videos (backlog_days 2 x videos_per_day 2) — nothing publishes this channel',
    )
    db.close()
  })

  it('says nothing about a channel still under its cap', () => {
    const db = memDb()
    for (let i = 1; i <= 3; i++) {
      seedJob(db, { id: `job-${i}`, channel: 'chan-a' })
      seedLibrary(db, `job-${i}`, 'ready', isoAgo(HOUR_MS))
    }

    expect(buildDigest(db, [publishChannel('chan-a')], ENV_OK)).not.toContain(
      'finished videos (backlog_days',
    )
    db.close()
  })

  it('names a channel declaring only tiktok as "nothing publishes this channel", not "paused until these publish"', () => {
    // platforms = ['tiktok'] is a legal declaration, but there is no tiktok
    // adapter, so publishPlatforms() filters it out and returns []. Inventory
    // is computed against that filtered (empty) list, so the message must
    // branch on the same filtered list — not on the raw, unfiltered
    // channel.platforms, which still contains 'tiktok' and would pick the
    // wrong branch.
    const db = memDb()
    for (let i = 1; i <= 4; i++) {
      seedJob(db, { id: `job-${i}`, channel: 'chan-a' })
      seedLibrary(db, `job-${i}`, 'ready', isoAgo(HOUR_MS))
    }

    const digest = buildDigest(
      db,
      [testChannel({ name: 'chan-a', platforms: ['tiktok'] })],
      ENV_OK,
    )
    expect(digest).toContain(
      'chan-a: holding 4 of 4 finished videos (backlog_days 2 x videos_per_day 2) — nothing publishes this channel',
    )
    expect(digest).not.toContain('production is paused until these publish or are rejected')
    db.close()
  })
})

describe('buildDigest — topic starvation action item', () => {
  it('flags a scouting+publishing channel with zero candidates and zero inventory', () => {
    const db = memDb()
    // generate_topics only, no rss/subreddits — the llm-only shape must still
    // trip the scoutsAnything gate.
    const chA = scoutingPublishChannel('chan-a', { subreddits: [], generateTopics: 3 })
    expect(buildDigest(db, [chA], ENV_OK)).toContain(
      '  chan-a: topic starvation — 0 candidate topics and 0 unpublished videos; publishing stops when the backlog drains (check [scout] rss feeds / generate_topics)',
    )
    db.close()
  })

  it('does not flag a channel that still has candidate topics or unpublished videos', () => {
    const db = memDb()
    // chan-a: a candidate topic queued, no inventory.
    seedTopic(db, { channel: 'chan-a', dedupeHash: 'h1', status: 'candidate' })
    // chan-b: a ready video backlogged, no candidate topics.
    seedJob(db, { id: 'job-b', channel: 'chan-b' })
    seedLibrary(db, 'job-b', 'ready', isoAgo(HOUR_MS))
    const digest = buildDigest(
      db,
      [scoutingPublishChannel('chan-a'), scoutingPublishChannel('chan-b')],
      ENV_OK,
    )
    expect(digest).not.toContain('topic starvation')
    db.close()
  })

  it('does not flag a channel with no scout sources configured (manual-produce channels)', () => {
    const db = memDb()
    // publishChannel carries the default empty scout config (no rss,
    // subreddits, or generate_topics) — a manual-produce channel, where an
    // empty topic queue is normal, not a starvation signal.
    const digest = buildDigest(db, [publishChannel('chan-a')], ENV_OK)
    expect(digest).not.toContain('topic starvation')
    db.close()
  })

  // A channel with 0 candidates and 0 inventory still has supply moving if a
  // topic is claimed (a job is producing from it right now) or a job is
  // running/queued — the alert must stay trustworthy and not cry wolf mid-flight.
  it('does not flag a channel with a claimed topic, even at 0 candidates and 0 inventory', () => {
    const db = memDb()
    seedJob(db, { id: 'job-inflight', channel: 'chan-a', status: 'running' })
    seedTopic(db, {
      channel: 'chan-a',
      dedupeHash: 'h-claimed',
      status: 'claimed',
      jobId: 'job-inflight',
    })
    const digest = buildDigest(db, [scoutingPublishChannel('chan-a')], ENV_OK)
    expect(digest).not.toContain('topic starvation')
    db.close()
  })

  it('does not flag a channel with a running job, even at 0 candidates and 0 inventory', () => {
    const db = memDb()
    seedJob(db, { id: 'job-running', channel: 'chan-a', status: 'running' })
    const digest = buildDigest(db, [scoutingPublishChannel('chan-a')], ENV_OK)
    expect(digest).not.toContain('topic starvation')
    db.close()
  })

  it('does not flag a channel with a queued job, even at 0 candidates and 0 inventory', () => {
    const db = memDb()
    seedJob(db, { id: 'job-queued', channel: 'chan-a', status: 'queued' })
    const digest = buildDigest(db, [scoutingPublishChannel('chan-a')], ENV_OK)
    expect(digest).not.toContain('topic starvation')
    db.close()
  })

  it('still flags at 0 candidates and 0 inventory with no in-flight topic or job', () => {
    const db = memDb()
    const digest = buildDigest(db, [scoutingPublishChannel('chan-a')], ENV_OK)
    expect(digest).toContain('topic starvation')
    db.close()
  })
})

describe('buildDigest — section order', () => {
  it('emits the five sections in the pinned order', () => {
    const db = memDb()
    const digest = buildDigest(db, [])
    const positions = [
      digest.indexOf('Topics (last 24h)'),
      digest.indexOf('Jobs (last 24h)'),
      digest.indexOf('Spend today (UTC)'),
      digest.indexOf('Publishing (last 24h)'),
      digest.indexOf('Action items'),
    ]
    expect(positions.every((p) => p >= 0)).toBe(true)
    expect([...positions].sort((a, b) => a - b)).toEqual(positions)
    db.close()
  })
})
