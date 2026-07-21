import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Database } from 'better-sqlite3'
import { openDb } from '../db/index.js'
import { testChannel } from '../stages/_testkit.js'
import { planTick, RESUME_MIN_HEADROOM_USD_MICROS } from './plan-tick.js'

const NOOP = { kind: 'noop', reason: 'no-eligible-work' } as const

// planTick only SELECTs, so raw-insert seeds control every column directly.
// seedJob defaults created_at to now (UTC today) — the claim-pass quota only
// counts today's rows; explicit createdAt pins ordering where it matters.
let jobSeq = 0
function seedJob(
  db: Database,
  overrides: Partial<{
    id: string
    channel: string
    tier: string
    status: string
    createdAt: string
  }> = {},
): string {
  jobSeq += 1
  const row = {
    id: `job-${jobSeq}`,
    channel: 'test',
    tier: 'volume',
    status: 'done',
    createdAt: new Date().toISOString(),
    ...overrides,
  }
  db.prepare(
    'INSERT INTO jobs (id, channel, tier, topic, status, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(row.id, row.channel, row.tier, `topic for ${row.id}`, row.status, row.createdAt)
  return row.id
}

let topicSeq = 0
function seedTopic(
  db: Database,
  overrides: Partial<{
    channel: string
    title: string
    score: number
    status: string
    jobId: string | null
    createdAt: string
  }> = {},
): number {
  topicSeq += 1
  const row = {
    channel: 'test',
    title: `Topic ${topicSeq}`,
    score: 80,
    status: 'candidate',
    jobId: null,
    createdAt: '2026-07-01T00:00:00.000Z',
    ...overrides,
  }
  const res = db
    .prepare(
      'INSERT INTO topics (channel, title, raw_title, source, url, dedupe_hash, score, reason, status, job_id, created_at) ' +
        'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    )
    .run(
      row.channel,
      row.title,
      `raw ${topicSeq}`,
      'reddit:r/space',
      `https://example.com/${topicSeq}`,
      `hash-${topicSeq}`,
      row.score,
      'seeded',
      row.status,
      row.jobId,
      row.createdAt,
    )
  return Number(res.lastInsertRowid)
}

// The global cap reads BRAINROT_GLOBAL_DAILY_USD at call time: pin the $25
// default even when the shell exports the var.
beforeEach(() => {
  vi.stubEnv('BRAINROT_GLOBAL_DAILY_USD', undefined)
})
afterEach(() => {
  vi.unstubAllEnvs()
})

describe('planTick basics', () => {
  it('exports the resume headroom constant in micro-USD', () => {
    expect(RESUME_MIN_HEADROOM_USD_MICROS).toBe(2_000_000)
  })

  it('noops when there are no blocked jobs and no topics', () => {
    const db = openDb(':memory:')
    expect(planTick(db, [testChannel()], { falKeyPresent: true })).toEqual(NOOP)
    db.close()
  })
})

describe('resume pass', () => {
  it('beats the claim pass when a blocked job is eligible', () => {
    const db = openDb(':memory:')
    seedJob(db, { id: 'job-parked', status: 'blocked' })
    seedTopic(db) // a claimable topic must not outrank the parked job
    expect(planTick(db, [testChannel()], { falKeyPresent: true })).toEqual({
      kind: 'resume',
      jobId: 'job-parked',
      channel: 'test',
      tier: 'volume',
    })
    db.close()
  })

  it('takes the oldest blocked job first', () => {
    const db = openDb(':memory:')
    seedJob(db, { id: 'job-newer', status: 'blocked', createdAt: '2026-07-02T00:00:00.000Z' })
    seedJob(db, { id: 'job-older', status: 'blocked', createdAt: '2026-07-01T00:00:00.000Z' })
    expect(planTick(db, [testChannel()], { falKeyPresent: true })).toMatchObject({
      kind: 'resume',
      jobId: 'job-older',
    })
    db.close()
  })

  it('skips a blocked job whose channel is missing and takes the next oldest', () => {
    const db = openDb(':memory:')
    // Oldest blocked job belongs to a channel whose TOML left the dir.
    seedJob(db, {
      id: 'job-ghost',
      channel: 'ghost',
      status: 'blocked',
      createdAt: '2026-07-01T00:00:00.000Z',
    })
    seedJob(db, { id: 'job-live', status: 'blocked', createdAt: '2026-07-02T00:00:00.000Z' })
    expect(planTick(db, [testChannel()], { falKeyPresent: true })).toMatchObject({
      kind: 'resume',
      jobId: 'job-live',
    })
    db.close()
  })

  it('carries the premium tier through the plan', () => {
    const db = openDb(':memory:')
    seedJob(db, { id: 'job-prem', tier: 'premium', status: 'blocked' })
    expect(planTick(db, [testChannel()], { falKeyPresent: true })).toEqual({
      kind: 'resume',
      jobId: 'job-prem',
      channel: 'test',
      tier: 'premium',
    })
    db.close()
  })
})
