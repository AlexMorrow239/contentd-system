import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Database } from 'better-sqlite3'
import { openDb } from '../db/index.js'
import { testChannel } from '../stages/_testkit.js'
import { buildDigest, STRANDED_QUEUED_MS, ZOMBIE_RUNNING_MS } from './digest.js'

const HOUR_MS = 3_600_000
const DAY_MS = 24 * HOUR_MS

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
    tier?: 'volume' | 'premium'
    status?: 'queued' | 'running' | 'failed' | 'done' | 'blocked'
    createdAt?: string
  },
): void {
  db.prepare(
    'INSERT INTO jobs (id, channel, tier, topic, status, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(
    opts.id,
    opts.channel ?? 'chan-a',
    opts.tier ?? 'volume',
    'digest test topic',
    opts.status ?? 'done',
    opts.createdAt ?? isoAgo(HOUR_MS),
  )
}

// Library rows carry the ready/needs-review outcome for 'done' jobs — the
// same insert shape the runner's library upsert writes.
function seedLibrary(db: Database, jobId: string, state: 'ready' | 'needs-review'): void {
  db.prepare(
    "INSERT INTO library (job_id, video_path, metadata_json, state) VALUES (?, '/tmp/out.mp4', '{}', ?)",
  ).run(jobId, state)
}

function seedTopic(
  db: Database,
  opts: {
    dedupeHash: string
    channel?: string
    status?: 'candidate' | 'approved' | 'claimed' | 'used' | 'rejected'
    createdAt?: string
  },
): void {
  db.prepare(
    'INSERT INTO topics (channel, title, raw_title, source, url, dedupe_hash, score, reason, status, created_at) ' +
      "VALUES (?, 'digest topic', 'raw', 'reddit:r/space', 'https://example.com', ?, 70, 'test', ?, ?)",
  ).run(
    opts.channel ?? 'chan-a',
    opts.dedupeHash,
    opts.status ?? 'candidate',
    opts.createdAt ?? isoAgo(HOUR_MS),
  )
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
    seedTopic(db, { dedupeHash: 'h3', status: 'approved' })
    seedTopic(db, { dedupeHash: 'h4', status: 'rejected' })
    // 3 days old — outside every reading of the 24h window
    seedTopic(db, { dedupeHash: 'h5', createdAt: isoAgo(3 * DAY_MS) })
    seedTopic(db, { channel: 'chan-b', dedupeHash: 'h6', status: 'rejected' })
    const digest = buildDigest(db, [])
    expect(digest).toContain('Topics (last 24h)')
    expect(digest).toContain('  chan-a: 4 scouted — 2 candidate, 1 approved, 1 rejected')
    expect(digest).toContain('  chan-b: 1 scouted — 0 candidate, 0 approved, 1 rejected')
    db.close()
  })

  it('prints none when no topics were scouted in the last 24h', () => {
    const db = openDb(':memory:')
    expect(buildDigest(db, [])).toContain('Topics (last 24h)\n  none')
    db.close()
  })
})

describe('buildDigest — jobs section', () => {
  it('counts last-24h jobs per channel and tier with library-resolved outcomes', () => {
    const db = openDb(':memory:')
    // chan-a volume: one ready (done + library row), one failed
    seedJob(db, { id: 'j-ready', status: 'done' })
    seedLibrary(db, 'j-ready', 'ready')
    seedJob(db, { id: 'j-failed', status: 'failed' })
    // chan-a premium: one needs-review, one blocked
    seedJob(db, { id: 'j-review', tier: 'premium', status: 'done' })
    seedLibrary(db, 'j-review', 'needs-review')
    seedJob(db, { id: 'j-blocked', tier: 'premium', status: 'blocked' })
    // 3 days old — outside the window, not counted here (it will surface in
    // the action-items section, which is current-state, not last-24h)
    seedJob(db, { id: 'j-old', status: 'failed', createdAt: isoAgo(3 * DAY_MS) })
    const digest = buildDigest(db, [])
    expect(digest).toContain('Jobs (last 24h)')
    expect(digest).toContain('  chan-a volume: 2 — 1 ready, 0 needs-review, 1 failed, 0 blocked')
    expect(digest).toContain('  chan-a premium: 2 — 0 ready, 1 needs-review, 0 failed, 1 blocked')
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
      premiumPerVideoUsdMicros: 7_000_000,
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
    seedJob(db, { id: 'j-dead', tier: 'premium', status: 'failed' })
    // 3h-old running job: past ZOMBIE_RUNNING_MS (2h) — flagged
    seedJob(db, { id: 'j-zombie', status: 'running', createdAt: isoAgo(3 * HOUR_MS) })
    // 1h-old running job: healthy — must NOT be flagged
    seedJob(db, { id: 'j-live', status: 'running', createdAt: isoAgo(HOUR_MS) })
    const digest = buildDigest(db, [])
    expect(digest).toContain('Action items')
    expect(digest).toContain('  failed job j-dead (chan-a, premium) — resume manually')
    expect(digest).toContain(
      '  running job j-zombie (chan-a, volume) running > 2h — probably crashed — resume with --force',
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
      '  queued job j-stranded (chan-a, volume) — stranded before start — resume with brainrot resume j-stranded',
    )
    expect(digest).not.toContain('j-fresh')
    db.close()
  })

  it('reports approved and candidate queue depths per channel', () => {
    const db = openDb(':memory:')
    seedTopic(db, { dedupeHash: 'h1', status: 'approved' })
    seedTopic(db, { dedupeHash: 'h2', status: 'approved' })
    seedTopic(db, { dedupeHash: 'h3', status: 'candidate' })
    seedTopic(db, { channel: 'chan-b', dedupeHash: 'h4', status: 'candidate' })
    // claimed/used topics are neither queued nor awaiting approval
    seedTopic(db, { dedupeHash: 'h5', status: 'used' })
    const digest = buildDigest(db, [])
    expect(digest).toContain('  chan-a: 2 approved premium topics queued')
    expect(digest).toContain('  chan-a: 1 candidate topics awaiting approval')
    expect(digest).toContain('  chan-b: 1 candidate topics awaiting approval')
    db.close()
  })

  it('prints none when there are no action items', () => {
    const db = openDb(':memory:')
    expect(buildDigest(db, [])).toContain('Action items\n  none')
    db.close()
  })
})

describe('buildDigest — section order', () => {
  it('emits the four sections in the pinned order', () => {
    const db = openDb(':memory:')
    const digest = buildDigest(db, [])
    const positions = [
      digest.indexOf('Topics (last 24h)'),
      digest.indexOf('Jobs (last 24h)'),
      digest.indexOf('Spend today (UTC)'),
      digest.indexOf('Action items'),
    ]
    expect(positions.every((p) => p >= 0)).toBe(true)
    expect([...positions].sort((a, b) => a - b)).toEqual(positions)
    db.close()
  })
})
