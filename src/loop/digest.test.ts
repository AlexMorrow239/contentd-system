import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Database } from 'better-sqlite3'
import { openDb } from '../db/index.js'
import { localDay } from '../publish/schedule.js'
import { upsertToken } from '../publish/tokens.js'
import { testChannel } from '../stages/_testkit.js'
import { buildDigest, STRANDED_QUEUED_MS, ZOMBIE_RUNNING_MS } from './digest.js'

const HOUR_MS = 3_600_000
const DAY_MS = 24 * HOUR_MS

// Same filler-key idiom as tokens.test.ts: AES-256 sized, never a real
// secret, and only ever handed to encrypt/decrypt round-trips here.
const TEST_KEY = Buffer.alloc(32, 0x42)
const TEST_KEY_HEX = TEST_KEY.toString('hex')
const OTHER_KEY_HEX = Buffer.alloc(32, 0x11).toString('hex')

// The env-dependent digest checks (blocked-job reasons, token health) read
// process.env by default; tests pass explicit presence flags so a developer's
// own .env can never flip an assertion.
const ENV_OK = {
  ytClientIdPresent: true,
  ytClientSecretPresent: true,
  tokenKeyHex: TEST_KEY_HEX,
}

// Explicit timestamps in the schema default's own format ('...T...Z' with
// millis) keep string comparisons against created_at meaningful.
function isoAgo(ms: number): string {
  return new Date(Date.now() - ms).toISOString()
}

function seedJob(
  db: Database,
  opts: {
    id: string
    channel?: string
    status?: 'queued' | 'running' | 'failed' | 'done' | 'blocked'
    createdAt?: string
  },
): void {
  db.prepare(
    "INSERT INTO jobs (id, channel, tier, topic, status, created_at) VALUES (?, ?, 'volume', ?, ?, ?)",
  ).run(
    opts.id,
    opts.channel ?? 'chan-a',
    'digest test topic',
    opts.status ?? 'done',
    opts.createdAt ?? isoAgo(HOUR_MS),
  )
}

// Library rows carry the ready/needs-review outcome for 'done' jobs — the
// same insert shape the runner's library upsert writes. createdAt is
// optional and only used by tests that need to control backlog age
// precisely; omitting it keeps the schema default ('now') for every
// existing caller.
function seedLibrary(
  db: Database,
  jobId: string,
  state: 'ready' | 'needs-review',
  createdAt?: string,
): void {
  if (createdAt === undefined) {
    db.prepare(
      "INSERT INTO library (job_id, video_path, metadata_json, state) VALUES (?, '/tmp/out.mp4', '{}', ?)",
    ).run(jobId, state)
    return
  }
  db.prepare(
    "INSERT INTO library (job_id, video_path, metadata_json, state, created_at) VALUES (?, '/tmp/out.mp4', '{}', ?, ?)",
  ).run(jobId, state, createdAt)
}

// Publishes rows carry the channel/slot/status shape the publish-next tick
// writes; day/slot default to fixed values so tests control the UNIQUE
// (channel, platform, day, slot) constraint explicitly.
function seedPublish(
  db: Database,
  opts: {
    jobId: string
    channel?: string
    platform?: 'youtube'
    day?: string
    slot?: string
    status?: 'claimed' | 'done' | 'failed' | 'interrupted'
    url?: string | null
    error?: string | null
    errorKind?: 'auth' | 'quota' | 'rejected' | 'transient' | null
    attempt?: number
    createdAt?: string
  },
): void {
  db.prepare(
    `INSERT INTO publishes
       (job_id, platform, channel, day, slot, status, url, error, error_kind, attempt, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    opts.jobId,
    opts.platform ?? 'youtube',
    opts.channel ?? 'chan-a',
    opts.day ?? '2026-07-19',
    opts.slot ?? '10:00',
    opts.status ?? 'done',
    opts.url ?? null,
    opts.error ?? null,
    opts.errorKind ?? null,
    opts.attempt ?? 1,
    opts.createdAt ?? isoAgo(HOUR_MS),
  )
}

// Returns the new topic id: the blocked-job remedy lines name the topic a
// blocked job still holds, so those tests need the id the row got.
function seedTopic(
  db: Database,
  opts: {
    dedupeHash: string
    channel?: string
    status?: 'candidate' | 'claimed' | 'used' | 'rejected'
    createdAt?: string
    jobId?: string
  },
): number {
  const info = db
    .prepare(
      'INSERT INTO topics (channel, title, raw_title, source, url, dedupe_hash, score, reason, status, created_at, job_id) ' +
        "VALUES (?, 'digest topic', 'raw', 'reddit:r/space', 'https://example.com', ?, 70, 'test', ?, ?, ?)",
    )
    .run(
      opts.channel ?? 'chan-a',
      opts.dedupeHash,
      opts.status ?? 'candidate',
      opts.createdAt ?? isoAgo(HOUR_MS),
      opts.jobId ?? null,
    )
  return Number(info.lastInsertRowid)
}

// The runner stamps started_at when a stage begins; the zombie check ages a
// running job by the latest such stamp, so tests control it directly.
function seedStage(db: Database, jobId: string, stage: string, startedAt: string): void {
  db.prepare(
    "INSERT INTO job_stages (job_id, stage, status, started_at) VALUES (?, ?, 'running', ?)",
  ).run(jobId, stage, startedAt)
}

function seedCost(db: Database, jobId: string, usdMicros: number): void {
  db.prepare(
    "INSERT INTO costs (job_id, provider, operation, usd_micros) VALUES (?, 'fal', 'video', ?)",
  ).run(jobId, usdMicros)
}

function publishChannel(name: string, overrides: { slots?: string[] } = {}) {
  return testChannel({
    name,
    publish: {
      targets: [
        {
          platform: 'youtube',
          slots: overrides.slots ?? ['10:00'],
          options: { privacy: 'public', categoryId: 24, madeForKids: false },
        },
      ],
    },
  })
}

function seedLibraryPath(db: Database, jobId: string, videoPath: string): void {
  db.prepare(
    "INSERT INTO library (job_id, video_path, metadata_json, state) VALUES (?, ?, '{}', 'ready')",
  ).run(jobId, videoPath)
}

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('buildDigest — topics section', () => {
  it('exports the 2h zombie constant', () => {
    expect(ZOMBIE_RUNNING_MS).toBe(7_200_000)
  })

  it('exports the 1h stranded-queued constant', () => {
    expect(STRANDED_QUEUED_MS).toBe(3_600_000)
  })

  it('counts last-24h topics per channel by status, excluding older rows', () => {
    const db = openDb(':memory:')
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
    const db = openDb(':memory:')
    expect(buildDigest(db, [])).toContain('Topics (last 24h)\n  none')
    db.close()
  })
})

describe('buildDigest — jobs section', () => {
  it('counts last-24h jobs per channel with library-resolved outcomes', () => {
    const db = openDb(':memory:')
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
    const db = openDb(':memory:')
    expect(buildDigest(db, [])).toContain('Jobs (last 24h)\n  none')
    db.close()
  })
})

describe('buildDigest — spend section', () => {
  it('formats channel and global day spend from integer micros as $X.XX', () => {
    vi.stubEnv('BRAINROT_GLOBAL_DAILY_USD', '10')
    const db = openDb(':memory:')
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
    const db = openDb(':memory:')
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
    const db = openDb(':memory:')
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
    const db = openDb(':memory:')
    expect(buildDigest(db, [])).toContain('Action items\n  none')
    db.close()
  })

  // The caller (the digest command) hands the load failure down instead of
  // aborting: the sqlite sections are still worth printing, and a report that
  // silently omits every channel-derived section reads as "all clear".
  it('names a channels-dir load failure as the first action item, above the db-derived ones', () => {
    const db = openDb(':memory:')
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
    const db = openDb(':memory:')
    const digest = buildDigest(db, [], {}, { channelsError: 'ENOENT: no such file or directory' })
    expect(digest).not.toContain('Action items\n  none')
    db.close()
  })
})

describe('buildDigest — publishing section', () => {
  it('lists a published video with its resolved title and url', () => {
    const db = openDb(':memory:')
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
      slot: '10:00',
      status: 'done',
      url: 'https://youtube.com/shorts/abc123',
    })
    const digest = buildDigest(db, [])
    expect(digest).toContain('Publishing (last 24h)')
    expect(digest).toContain('  Published:')
    expect(digest).toContain('    chan-a 10:00 "Moon Facts" — https://youtube.com/shorts/abc123')
    db.close()
  })

  it('lists a failed attempt with its error kind and truncates the error to 80 chars', () => {
    const db = openDb(':memory:')
    const longError = 'x'.repeat(120)
    seedPublish(db, {
      jobId: 'j-fail',
      channel: 'chan-b',
      slot: '14:00',
      status: 'failed',
      errorKind: 'rejected',
      error: longError,
    })
    const digest = buildDigest(db, [])
    expect(digest).toContain(`    chan-b 14:00 rejected: ${'x'.repeat(80)}`)
    expect(digest).not.toContain('x'.repeat(81))
    db.close()
  })

  it('prints none for both subsections when nothing published or failed in the last 24h', () => {
    const db = openDb(':memory:')
    const digest = buildDigest(db, [])
    expect(digest).toContain('  Published:\n    none')
    expect(digest).toContain('  Failed:\n    none')
    db.close()
  })

  it('excludes publishes older than 24h', () => {
    const db = openDb(':memory:')
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
    const db = openDb(':memory:')
    seedPublish(db, {
      jobId: 'j1',
      channel: 'chan-a',
      slot: '10:00',
      status: 'failed',
      errorKind: 'auth',
    })
    seedPublish(db, {
      jobId: 'j2',
      channel: 'chan-a',
      slot: '14:00',
      status: 'failed',
      errorKind: 'auth',
    })
    const digest = buildDigest(db, [])
    expect(digest).toContain(
      '  chan-a youtube: 2 auth failures in the last 24h — run brainrot auth youtube --channel chan-a',
    )
    db.close()
  })

  it('flags quota failures distinctly — the cap estimate and reality disagree', () => {
    const db = openDb(':memory:')
    seedPublish(db, {
      jobId: 'j1',
      channel: 'chan-a',
      slot: '10:00',
      status: 'failed',
      errorKind: 'quota',
    })
    seedPublish(db, {
      jobId: 'j2',
      channel: 'chan-a',
      slot: '14:00',
      status: 'failed',
      errorKind: 'quota',
    })
    const digest = buildDigest(db, [])
    expect(digest).toContain(
      '  chan-a youtube: 2 quota failures in the last 24h — the platform refused the upload; check BRAINROT_YT_UPLOADS_PER_DAY against the real quota',
    )
    db.close()
  })

  it('instructs checking Studio for interrupted uploads of any age', () => {
    const db = openDb(':memory:')
    seedPublish(db, {
      jobId: 'j-int',
      channel: 'chan-a',
      slot: '19:00',
      status: 'interrupted',
      createdAt: isoAgo(3 * DAY_MS),
    })
    const digest = buildDigest(db, [])
    expect(digest).toContain(
      '  interrupted publish j-int (chan-a, youtube, 19:00) — check YouTube Studio, then brainrot publish retry j-int or brainrot publish mark-done j-int <postId>',
    )
    db.close()
  })

  it('suggests library reject for a job at the rejected attempt cap while still ready', () => {
    const db = openDb(':memory:')
    seedJob(db, { id: 'j-capped', channel: 'chan-a' })
    seedLibrary(db, 'j-capped', 'ready')
    seedPublish(db, {
      jobId: 'j-capped',
      channel: 'chan-a',
      day: '2026-07-19',
      slot: '08:00',
      status: 'failed',
      errorKind: 'rejected',
    })
    seedPublish(db, {
      jobId: 'j-capped',
      channel: 'chan-a',
      day: '2026-07-19',
      slot: '12:00',
      status: 'failed',
      errorKind: 'rejected',
    })
    seedPublish(db, {
      jobId: 'j-capped',
      channel: 'chan-a',
      day: '2026-07-19',
      slot: '16:00',
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
    const db = openDb(':memory:')
    seedJob(db, { id: 'j-under', channel: 'chan-a' })
    seedLibrary(db, 'j-under', 'ready')
    seedPublish(db, {
      jobId: 'j-under',
      channel: 'chan-a',
      day: '2026-07-19',
      slot: '08:00',
      status: 'failed',
      errorKind: 'rejected',
    })
    seedPublish(db, {
      jobId: 'j-under',
      channel: 'chan-a',
      day: '2026-07-19',
      slot: '12:00',
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
    const db = openDb(':memory:')
    const chA = testChannel({
      name: 'chan-a',
      publish: {
        targets: [
          {
            platform: 'youtube',
            slots: ['10:00'],
            options: { privacy: 'public', categoryId: 24, madeForKids: false },
          },
        ],
      },
    })
    const chB = testChannel({ name: 'chan-b', publish: null })
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
    const db = openDb(':memory:')
    const digest = buildDigest(db, [])
    expect(digest).toContain('  Backlog:\n    none')
    db.close()
  })
})

describe('buildDigest — lapsed-slots action item', () => {
  it('reports slots that lapsed unfilled yesterday for channels with a publish config', () => {
    const db = openDb(':memory:')
    // Mirror the impl's own local field math (new Date(now); setDate(-1);
    // localDay) — now-minus-24h lands on the wrong local date across a DST
    // transition and would diverge from the digest in that window.
    const yesterdayDate = new Date()
    yesterdayDate.setDate(yesterdayDate.getDate() - 1)
    const yesterday = localDay(yesterdayDate)
    const chA = testChannel({
      name: 'chan-a',
      publish: {
        targets: [
          {
            platform: 'youtube',
            slots: ['09:00', '14:00', '19:00'],
            options: { privacy: 'public', categoryId: 24, madeForKids: false },
          },
        ],
      },
    })
    seedJob(db, { id: 'j-yday', channel: 'chan-a' })
    seedPublish(db, {
      jobId: 'j-yday',
      channel: 'chan-a',
      day: yesterday,
      slot: '09:00',
      status: 'done',
    })
    const digest = buildDigest(db, [chA])
    expect(digest).toContain(
      `  chan-a youtube: slots 14:00, 19:00 lapsed unfilled yesterday (${yesterday})`,
    )
    expect(digest).not.toContain('09:00 lapsed')
    db.close()
  })

  it('does not flag lapsed slots for a channel with no publish config', () => {
    const db = openDb(':memory:')
    const chB = testChannel({ name: 'chan-b', publish: null })
    const digest = buildDigest(db, [chB])
    expect(digest).not.toContain('lapsed unfilled yesterday')
    db.close()
  })
})

describe('buildDigest — zombie age comes from the latest stage start', () => {
  it('does not flag an old job whose latest stage started minutes ago', () => {
    const db = openDb(':memory:')
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
    const db = openDb(':memory:')
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
    const db = openDb(':memory:')
    seedJob(db, { id: 'j-nostage', status: 'running', createdAt: isoAgo(3 * HOUR_MS) })
    const digest = buildDigest(db, [], ENV_OK)
    expect(digest).toContain('  running job j-nostage (chan-a) running > 2h')
    db.close()
  })
})

describe('buildDigest — failed-job list cap', () => {
  it('lists the 10 most recent failures and counts the rest in one line', () => {
    const db = openDb(':memory:')
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
    const db = openDb(':memory:')
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
    const db = openDb(':memory:')
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
    const db = openDb(':memory:')
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
    const db = openDb(':memory:')
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
    const db = openDb(':memory:')
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

describe('buildDigest — publish token health', () => {
  it('tells the operator to authorize a publish-enabled channel with no stored token', () => {
    const db = openDb(':memory:')
    const digest = buildDigest(db, [publishChannel('chan-a')], ENV_OK)
    expect(digest).toContain(
      '  chan-a youtube: no stored token — run brainrot auth youtube --channel chan-a',
    )
    db.close()
  })

  it('names the key rotation when a stored token no longer decrypts', () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
    const db = openDb(':memory:')
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
    const db = openDb(':memory:')
    upsertToken(db, 'youtube', 'chan-a', 'rt-test-token', 'scope', TEST_KEY)
    const digest = buildDigest(db, [publishChannel('chan-a')], ENV_OK)
    expect(digest).not.toContain('chan-a youtube: no stored token')
    expect(digest).not.toContain('does not decrypt')
    db.close()
  })

  it('lists the unset publish env vars once, by name', () => {
    const db = openDb(':memory:')
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
    const db = openDb(':memory:')
    const digest = buildDigest(db, [publishChannel('chan-a')], { ...ENV_OK, tokenKeyHex: 'nothex' })
    expect(digest).toContain(
      '  BRAINROT_TOKEN_KEY is set but is not 64 hex characters — stored tokens cannot be decrypted',
    )
    expect(digest).not.toContain('nothex')
    db.close()
  })

  it('checks no tokens for a channel without a publish config', () => {
    const db = openDb(':memory:')
    const digest = buildDigest(db, [testChannel({ name: 'chan-b', publish: null })], ENV_OK)
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
      publish: {
        targets: [
          {
            platform: 'instagram',
            slots: ['10:00'],
            options: { igUserId: 'ig-1', shareToFeed: true },
          },
        ],
      },
    })
  }

  it('warns when a stored token expires within the 3-day window', () => {
    const db = openDb(':memory:')
    const channel = instagramChannel('chan-a')
    const soonExpiry = new Date(Date.now() + 2 * DAY_MS).toISOString()
    upsertToken(db, 'instagram', 'chan-a', 'tok', 'scope', TEST_KEY, soonExpiry)
    const digest = buildDigest(db, [channel], ENV_OK)
    expect(digest).toContain(`  chan-a instagram: stored token expires ${soonExpiry}`)
    db.close()
  })

  it('does not warn when expiry is far out', () => {
    const db = openDb(':memory:')
    const channel = instagramChannel('chan-a')
    const farExpiry = new Date(Date.now() + 30 * DAY_MS).toISOString()
    upsertToken(db, 'instagram', 'chan-a', 'tok', 'scope', TEST_KEY, farExpiry)
    const digest = buildDigest(db, [channel], ENV_OK)
    expect(digest).not.toContain('stored token expires')
    db.close()
  })

  it('never warns for a null expiry (youtube)', () => {
    const db = openDb(':memory:')
    const channel = publishChannel('chan-a')
    upsertToken(db, 'youtube', 'chan-a', 'rt', 'scope', TEST_KEY)
    const digest = buildDigest(db, [channel], ENV_OK)
    expect(digest).not.toContain('stored token expires')
    db.close()
  })
})

describe('buildDigest — library rows with no stored object', () => {
  it('flags a ready library row that has no library_objects row', () => {
    const db = openDb(':memory:')
    seedJob(db, { id: 'j-unstored', channel: 'chan-a' })
    seedLibrary(db, 'j-unstored', 'ready')
    const digest = buildDigest(db, [], ENV_OK)
    expect(digest).toContain(
      '  job j-unstored (chan-a) has no stored object — run brainrot library backfill-store',
    )
    db.close()
  })

  it('does not flag a row whose local file is gone but is stored', () => {
    const db = openDb(':memory:')
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
    const db = openDb(':memory:')
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
    const db = openDb(':memory:')
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
    const db = openDb(':memory:')
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

describe('buildDigest — section order', () => {
  it('emits the five sections in the pinned order', () => {
    const db = openDb(':memory:')
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
