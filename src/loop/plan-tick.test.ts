import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Database } from 'better-sqlite3'
import { recordCost } from '../jobs/costs.js'
import { testChannel } from '../testing/channel.js'
import { planTick, RESUME_MIN_HEADROOM_USD_MICROS } from './plan-tick.js'
import { memDb } from '../testing/db.js'

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
    status: string
    createdAt: string
  }> = {},
): string {
  jobSeq += 1
  const row = {
    id: `job-${jobSeq}`,
    channel: 'test',
    status: 'done',
    createdAt: new Date().toISOString(),
    ...overrides,
  }
  db.prepare(
    "INSERT INTO jobs (id, channel, tier, topic, status, created_at) VALUES (?, ?, 'volume', ?, ?, ?)",
  ).run(row.id, row.channel, `topic for ${row.id}`, row.status, row.createdAt)
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
    const db = memDb()
    expect(planTick(db, [testChannel()])).toEqual(NOOP)
    db.close()
  })
})

describe('resume pass', () => {
  it('beats the claim pass when a blocked job is eligible', () => {
    const db = memDb()
    seedJob(db, { id: 'job-parked', status: 'blocked' })
    seedTopic(db) // a claimable topic must not outrank the parked job
    expect(planTick(db, [testChannel()])).toEqual({
      kind: 'resume',
      jobId: 'job-parked',
      channel: 'test',
    })
    db.close()
  })

  it('takes the oldest blocked job first', () => {
    const db = memDb()
    seedJob(db, { id: 'job-newer', status: 'blocked', createdAt: '2026-07-02T00:00:00.000Z' })
    seedJob(db, { id: 'job-older', status: 'blocked', createdAt: '2026-07-01T00:00:00.000Z' })
    expect(planTick(db, [testChannel()])).toMatchObject({
      kind: 'resume',
      jobId: 'job-older',
    })
    db.close()
  })

  it('skips a blocked job whose channel is missing and takes the next oldest', () => {
    const db = memDb()
    // Oldest blocked job belongs to a channel whose TOML left the dir.
    seedJob(db, {
      id: 'job-ghost',
      channel: 'ghost',
      status: 'blocked',
      createdAt: '2026-07-01T00:00:00.000Z',
    })
    seedJob(db, { id: 'job-live', status: 'blocked', createdAt: '2026-07-02T00:00:00.000Z' })
    expect(planTick(db, [testChannel()])).toMatchObject({
      kind: 'resume',
      jobId: 'job-live',
    })
    db.close()
  })
})

describe('resume pass skip conditions', () => {
  const cases: {
    reason: string
    expected: 'no-eligible-work'
    seed: (db: Database) => void
  }[] = [
    {
      reason: 'channel-day headroom is under the resume minimum',
      expected: 'no-eligible-work',
      seed: (db) => {
        seedJob(db, { id: 'job-parked', status: 'blocked' })
        // $20 channel-day cap − $18.50 spent today = $1.50 < $2 headroom
        const spender = seedJob(db)
        recordCost(db, spender, 'fal', 'video', 18_500_000)
      },
    },
    {
      reason: 'global-day headroom is under the resume minimum',
      expected: 'no-eligible-work',
      seed: (db) => {
        seedJob(db, { id: 'job-parked', status: 'blocked' })
        // Jobless sentinel spend: invisible to the channel-day JOIN, counted
        // by the global sum. $25 default cap − $23.50 = $1.50 < $2 headroom.
        recordCost(db, 'scout:test', 'anthropic', 'scout-score', 23_500_000)
      },
    },
  ]

  it.each(cases)('skips the blocked job when $reason', ({ expected, seed }) => {
    const db = memDb()
    seed(db)
    expect(planTick(db, [testChannel()])).toEqual({
      kind: 'noop',
      reason: expected,
    })
    db.close()
  })
})

describe('resume pass per-video headroom', () => {
  it('skips a blocked job at its per-video cap so the claim pass still runs', () => {
    const db = memDb()
    seedJob(db, { id: 'job-capped', status: 'blocked' })
    // The whole $8 per-video cap is already spent: resuming could only
    // re-block at the first checkpoint, and the job keeps its place at the
    // head of the oldest-first queue — every channel starves forever.
    recordCost(db, 'job-capped', 'fal', 'video', 8_000_000)
    const topicId = seedTopic(db)
    expect(planTick(db, [testChannel()])).toMatchObject({
      kind: 'produce',
      topicId,
    })
    db.close()
  })

  it('resumes while a full minimum step of per-video headroom remains', () => {
    const db = memDb()
    seedJob(db, { id: 'job-parked', status: 'blocked' })
    // $8 cap − $6 spent = exactly the $2 step: the guard is strictly-less, so
    // this job is still worth resuming.
    recordCost(db, 'job-parked', 'fal', 'video', 6_000_000)
    expect(planTick(db, [testChannel()])).toMatchObject({
      kind: 'resume',
      jobId: 'job-parked',
    })
    db.close()
  })

  it('scales the floor down for a channel whose whole daily budget is under $2', () => {
    const db = memDb()
    seedJob(db, { id: 'job-parked', status: 'blocked' })
    // A $1.50/day channel can never clear the absolute $2 floor, so a flat
    // floor would lock its blocked jobs out permanently — even at zero spend.
    const ch = testChannel({
      budget: { perVideoUsdMicros: 1_000_000, perDayUsdMicros: 1_500_000 },
    })
    expect(planTick(db, [ch])).toMatchObject({
      kind: 'resume',
      jobId: 'job-parked',
    })
    db.close()
  })
})

describe('claim pass', () => {
  it('claims the best eligible topic', () => {
    const db = memDb()
    const best = seedTopic(db, { title: 'Why the Moon is drifting away', score: 90 })
    seedTopic(db, { title: 'runner-up', score: 70 })
    expect(planTick(db, [testChannel()])).toEqual({
      kind: 'produce',
      channel: 'test',
      topicId: best,
      topic: 'Why the Moon is drifting away',
    })
    db.close()
  })
})

describe('claim pass quota', () => {
  it.each(['queued', 'running', 'failed', 'done'])(
    'a %s job created today consumes its daily slot',
    (status) => {
      const db = memDb()
      seedJob(db, { status })
      seedTopic(db)
      const ch = testChannel({ videosPerDay: 1 })
      expect(planTick(db, [ch])).toEqual(NOOP)
      db.close()
    },
  )

  it('counts blocked jobs toward the claim quota too', () => {
    const db = memDb()
    // Sentinel spend empties GLOBAL headroom so the resume pass skips the
    // blocked job; the claim pass must then see its slot as taken.
    seedJob(db, { status: 'blocked' })
    recordCost(db, 'scout:test', 'anthropic', 'scout-score', 23_500_000)
    seedTopic(db)
    const ch = testChannel({ videosPerDay: 1 })
    expect(planTick(db, [ch])).toEqual(NOOP)
    db.close()
  })

  it('ignores jobs from previous UTC days', () => {
    const db = memDb()
    seedJob(db, { status: 'failed', createdAt: '2020-01-01T00:00:00.000Z' })
    const topicId = seedTopic(db)
    const ch = testChannel({ videosPerDay: 1 })
    expect(planTick(db, [ch])).toMatchObject({
      kind: 'produce',
      topicId,
    })
    db.close()
  })
})

describe('claim pass channel fairness', () => {
  it('prefers the channel with the lowest filled fraction of its daily quota', () => {
    const db = memDb()
    seedJob(db, { channel: 'chan-a' }) // 1 of 2 slots → 0.5
    seedJob(db, { channel: 'chan-b' }) // 1 of 4 slots → 0.25
    seedTopic(db, { channel: 'chan-a', title: 'a topic' })
    const bTopic = seedTopic(db, { channel: 'chan-b', title: 'b topic' })
    const chA = testChannel({ name: 'chan-a', videosPerDay: 2 })
    const chB = testChannel({ name: 'chan-b', videosPerDay: 4 })
    expect(planTick(db, [chA, chB])).toMatchObject({
      kind: 'produce',
      channel: 'chan-b',
      topicId: bTopic,
    })
    db.close()
  })

  it('breaks filled-fraction ties by channel name ascending', () => {
    const db = memDb()
    seedTopic(db, { channel: 'chan-a', title: 'a topic' })
    seedTopic(db, { channel: 'chan-b', title: 'b topic' })
    const chA = testChannel({ name: 'chan-a', videosPerDay: 2 })
    const chB = testChannel({ name: 'chan-b', videosPerDay: 2 })
    // Reversed input order: the sort, not the argument order, must decide.
    expect(planTick(db, [chB, chA])).toMatchObject({
      kind: 'produce',
      channel: 'chan-a',
    })
    db.close()
  })

  it('falls through to the next channel when the fairest one has no topics', () => {
    const db = memDb()
    const bTopic = seedTopic(db, { channel: 'chan-b', title: 'b topic' })
    const chA = testChannel({ name: 'chan-a', videosPerDay: 2 })
    const chB = testChannel({ name: 'chan-b', videosPerDay: 2 })
    expect(planTick(db, [chA, chB])).toMatchObject({
      kind: 'produce',
      channel: 'chan-b',
      topicId: bTopic,
    })
    db.close()
  })
})
