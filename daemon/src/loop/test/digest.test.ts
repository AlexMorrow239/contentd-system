import { describe, expect, it, vi } from 'vitest'
import { memDb } from '../../../testing/db.js'
import { testChannel } from '../../../testing/channel.js'
import { buildDigest, STRANDED_QUEUED_MS, ZOMBIE_RUNNING_MS } from '../digest.js'
import {
  DAY_MS,
  HOUR_MS,
  isoAgo,
  publishChannel,
  scoutingPublishChannel,
  seedCost,
  seedJob,
  seedLibrary,
  seedPost,
  seedStage,
  seedTopic,
} from './_digest.fixtures.js'

/**
 * The assembled operator digest: pipeline health (topics, jobs, spend,
 * action items, zombie/stranded aging, the failed-job cap, blocked jobs),
 * the Posting section (unposted counts, oldest age, production-held marker),
 * and the section order they're assembled in. Shared seeds live in
 * _digest.fixtures.ts.
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
    const digest = buildDigest(db, [], {
      channelsError: 'failed to load channel config a.toml: bad',
    })
    expect(digest).toContain(
      'Action items\n  the channels dir did not load (failed to load channel config a.toml: bad) — spend, posting, and channel-derived action items are missing from this report',
    )
    // and it never displaces the sqlite-derived items
    expect(digest).toContain('  failed job j-failed (chan-a) — resume manually')
    db.close()
  })

  it('the config-error line suppresses the none placeholder', () => {
    const db = memDb()
    const digest = buildDigest(db, [], { channelsError: 'ENOENT: no such file or directory' })
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
    const digest = buildDigest(db, [])
    expect(digest).not.toContain('j-resumed')
    db.close()
  })

  it('flags a running job whose latest stage started before the zombie threshold', () => {
    const db = memDb()
    seedJob(db, { id: 'j-stuck', status: 'running', createdAt: isoAgo(10 * HOUR_MS) })
    seedStage(db, 'j-stuck', 'script', isoAgo(4 * HOUR_MS))
    seedStage(db, 'j-stuck', 'visuals', isoAgo(3 * HOUR_MS))
    const digest = buildDigest(db, [])
    expect(digest).toContain(
      '  running job j-stuck (chan-a) running > 2h — probably crashed — resume with --force',
    )
    db.close()
  })

  it('still ages a stageless running job by created_at', () => {
    const db = memDb()
    seedJob(db, { id: 'j-nostage', status: 'running', createdAt: isoAgo(3 * HOUR_MS) })
    const digest = buildDigest(db, [])
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
    const digest = buildDigest(db, [])
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
    const digest = buildDigest(db, [])
    expect(digest).toContain('  failed job j-f0 (chan-a) — resume manually')
    expect(digest).not.toContain('older failures')
    db.close()
  })
})

describe('buildDigest — blocked jobs that cannot resume', () => {
  it('reports the actual refused call and earliest retry even with positive headroom', () => {
    const db = memDb()
    seedJob(db, { id: 'j-wait', channel: 'chan-a', status: 'blocked' })
    seedCost(db, 'j-wait', 7_000_000)
    db.prepare('UPDATE jobs SET budget_wait_json = ?, retry_after = ? WHERE id = ?').run(
      JSON.stringify({
        version: 1,
        stage: 'voice',
        reason: 'per-video budget exceeded',
        utcDay: '2026-09-29',
        configFingerprint: 'abc',
        details: {
          scope: 'per-video',
          upcomingUsdMicros: 2_000_000,
          spentUsdMicros: 7_000_000,
          capUsdMicros: 8_000_000,
          utcDay: '2026-09-29',
        },
      }),
      '2026-09-29T12:01:00.000Z',
      'j-wait',
    )
    const digest = buildDigest(db, [testChannel({ name: 'chan-a' })])
    expect(digest).toContain('budget wait at voice: per-video budget exceeded')
    expect(digest).toContain('next call $2.00; recorded spend $7.00 of $8.00 per-video cap')
    expect(digest).toContain('next eligibility check no earlier than 2026-09-29T12:01:00.000Z')
    expect(digest).not.toContain('per-video budget left — awaiting the resume pass')
  })

  // Remedies must name commands that exist: there is no way to "reject" a
  // blocked job (library reject only touches library rows, which a blocked
  // job never has), so these lines name `resume` and, when the job still
  // holds a topic, `topics requeue`.
  it('names a blocked job whose channel config left the channels dir', () => {
    const db = memDb()
    seedJob(db, { id: 'j-orphan', channel: 'gone', status: 'blocked' })
    const digest = buildDigest(db, [])
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
    const digest = buildDigest(db, [])
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
    const digest = buildDigest(db, [testChannel({ name: 'chan-a' })])
    expect(digest).toContain(
      '  blocked job j-spent (chan-a) — per-video budget spent ($8.00 of $8.00) — raise the cap in chan-a.toml then brainrot resume j-spent',
    )
    db.close()
  })

  it('reports remaining headroom for a blocked job that can still resume', () => {
    const db = memDb()
    seedJob(db, { id: 'j-wait', channel: 'chan-a', status: 'blocked' })
    seedCost(db, 'j-wait', 2_000_000)
    const digest = buildDigest(db, [testChannel({ name: 'chan-a' })])
    // per-video cap is $8.00 in testChannel.
    expect(digest).toContain(
      '  blocked job j-wait (chan-a) — $6.00 of its $8.00 per-video budget left — awaiting the resume pass',
    )
    db.close()
  })
})

describe('buildDigest — Posting section', () => {
  it('reports unposted count and the oldest, per channel', () => {
    const db = memDb()
    seedJob(db, { id: 'j1', channel: 'alpha' })
    seedLibrary(db, 'j1', 'ready', isoAgo(3 * DAY_MS))
    const text = buildDigest(db, [testChannel({ name: 'alpha', platforms: ['youtube'] })])
    expect(text).toContain('Posting')
    expect(text).toMatch(/alpha\s+1 unposted \(oldest 3d\)/)
    db.close()
  })

  it('marks a channel whose backlog has halted production', () => {
    const db = memDb()
    // videos_per_day 1 x backlog_days 1 = a cap of 1, met by the one ready row.
    const channel = testChannel({
      name: 'alpha',
      platforms: ['youtube'],
      videosPerDay: 1,
      backlogDays: 1,
    })
    seedJob(db, { id: 'j1', channel: 'alpha' })
    seedLibrary(db, 'j1', 'ready')
    expect(buildDigest(db, [channel])).toContain('production held')
    db.close()
  })

  it('does not mark a channel still under its backlog cap', () => {
    const db = memDb()
    // videos_per_day 2 x backlog_days 2 = a cap of 4; one ready row is well under it.
    const channel = testChannel({
      name: 'alpha',
      platforms: ['youtube'],
      videosPerDay: 2,
      backlogDays: 2,
    })
    seedJob(db, { id: 'j1', channel: 'alpha' })
    seedLibrary(db, 'j1', 'ready')
    expect(buildDigest(db, [channel])).not.toContain('production held')
    db.close()
  })

  it('omits channels that declare no platforms', () => {
    const db = memDb()
    seedJob(db, { id: 'j1', channel: 'alpha' })
    seedLibrary(db, 'j1', 'ready')
    const text = buildDigest(db, [testChannel({ name: 'alpha', platforms: [] })])
    expect(text).not.toMatch(/alpha\s+\d+ unposted/)
    db.close()
  })

  it('excludes a video already posted to every declared platform', () => {
    const db = memDb()
    seedJob(db, { id: 'j1', channel: 'alpha' })
    seedLibrary(db, 'j1', 'ready')
    seedPost(db, { jobId: 'j1', channel: 'alpha', platform: 'youtube' })
    const text = buildDigest(db, [testChannel({ name: 'alpha', platforms: ['youtube'] })])
    expect(text).not.toMatch(/alpha\s+\d+ unposted/)
    db.close()
  })

  // pendingInventory (daemon/src/jobs/library.ts) counts a video as pending until it
  // is posted to EVERY declared platform — a partial post must not hide it.
  it('still counts a video posted to only some of its declared platforms', () => {
    const db = memDb()
    seedJob(db, { id: 'j1', channel: 'alpha' })
    seedLibrary(db, 'j1', 'ready')
    seedPost(db, { jobId: 'j1', channel: 'alpha', platform: 'youtube' })
    const text = buildDigest(db, [
      testChannel({ name: 'alpha', platforms: ['youtube', 'instagram'] }),
    ])
    expect(text).toMatch(/alpha\s+1 unposted/)
    db.close()
  })

  it('says so when nothing is waiting', () => {
    const db = memDb()
    const text = buildDigest(db, [testChannel({ name: 'alpha', platforms: ['youtube'] })])
    expect(text).toContain('nothing waiting to post')
    db.close()
  })
})

describe('buildDigest — topic starvation action item', () => {
  it('flags a scouting+publishing channel with zero candidates and zero inventory', () => {
    const db = memDb()
    const chA = scoutingPublishChannel('chan-a')
    expect(buildDigest(db, [chA])).toContain(
      '  chan-a: topic starvation — 0 candidate topics and 0 unpublished videos; publishing stops when the backlog drains (check [scout] subreddits and https://status.arctic-shift.photon-reddit.com)',
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
    const digest = buildDigest(db, [
      scoutingPublishChannel('chan-a'),
      scoutingPublishChannel('chan-b'),
    ])
    expect(digest).not.toContain('topic starvation')
    db.close()
  })

  it('does not flag a channel with no scout sources configured (manual-produce channels)', () => {
    const db = memDb()
    // publishChannel carries the default empty scout config (no subreddits)
    // — a manual-produce channel, where an empty topic queue is normal, not a
    // starvation signal.
    const digest = buildDigest(db, [publishChannel('chan-a')])
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
    const digest = buildDigest(db, [scoutingPublishChannel('chan-a')])
    expect(digest).not.toContain('topic starvation')
    db.close()
  })

  it('does not flag a channel with a running job, even at 0 candidates and 0 inventory', () => {
    const db = memDb()
    seedJob(db, { id: 'job-running', channel: 'chan-a', status: 'running' })
    const digest = buildDigest(db, [scoutingPublishChannel('chan-a')])
    expect(digest).not.toContain('topic starvation')
    db.close()
  })

  it('does not flag a channel with a queued job, even at 0 candidates and 0 inventory', () => {
    const db = memDb()
    seedJob(db, { id: 'job-queued', channel: 'chan-a', status: 'queued' })
    const digest = buildDigest(db, [scoutingPublishChannel('chan-a')])
    expect(digest).not.toContain('topic starvation')
    db.close()
  })

  it('still flags at 0 candidates and 0 inventory with no in-flight topic or job', () => {
    const db = memDb()
    const digest = buildDigest(db, [scoutingPublishChannel('chan-a')])
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
      digest.indexOf('Posting'),
      digest.indexOf('Action items'),
    ]
    expect(positions.every((p) => p >= 0)).toBe(true)
    expect([...positions].sort((a, b) => a - b)).toEqual(positions)
    db.close()
  })
})
