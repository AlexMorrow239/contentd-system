import { describe, expect, it, vi } from 'vitest'
import { memDb } from '../testing/db.js'
import { testChannel } from '../testing/channel.js'
import { buildDigest, STRANDED_QUEUED_MS, ZOMBIE_RUNNING_MS } from './digest.js'
import {
  DAY_MS,
  ENV_OK,
  HOUR_MS,
  isoAgo,
  seedCost,
  seedJob,
  seedLibrary,
  seedStage,
  seedTopic,
} from './_digest.fixtures.js'

/**
 * The pipeline-health sections: topics, jobs, spend, action items, zombie
 * age, the failed-job cap, and blocked jobs that cannot resume.
 *
 * Split from a single 964-line digest.test.ts whose fifteen describes already
 * mapped 1:1 onto sections of the digest's output. Shared seeds live in
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
