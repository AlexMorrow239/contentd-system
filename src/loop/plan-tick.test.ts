import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Database } from 'better-sqlite3'
import { DEFAULT_SCOUT } from '../config/channel.js'
import { openDb } from '../db/index.js'
import { recordCost } from '../jobs/costs.js'
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

describe('resume pass skip conditions', () => {
  const cases: {
    reason: string
    falKeyPresent: boolean
    expected: 'no-eligible-work' | 'no-fal-key'
    seed: (db: Database) => void
  }[] = [
    {
      reason: 'the job is premium and the FAL key is absent',
      falKeyPresent: false,
      expected: 'no-fal-key',
      seed: (db) => {
        seedJob(db, { id: 'job-parked', tier: 'premium', status: 'blocked' })
      },
    },
    {
      reason: 'channel-day headroom is under the resume minimum',
      falKeyPresent: true,
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
      falKeyPresent: true,
      expected: 'no-eligible-work',
      seed: (db) => {
        seedJob(db, { id: 'job-parked', status: 'blocked' })
        // Jobless sentinel spend: invisible to the channel-day JOIN, counted
        // by the global sum. $25 default cap − $23.50 = $1.50 < $2 headroom.
        recordCost(db, 'scout:test', 'anthropic', 'scout-score', 23_500_000)
      },
    },
  ]

  it.each(cases)('skips the blocked job when $reason', ({ falKeyPresent, expected, seed }) => {
    const db = openDb(':memory:')
    seed(db)
    expect(planTick(db, [testChannel()], { falKeyPresent })).toEqual({
      kind: 'noop',
      reason: expected,
    })
    db.close()
  })
})

describe('claim pass', () => {
  it('claims the best eligible volume topic', () => {
    const db = openDb(':memory:')
    const best = seedTopic(db, { title: 'Why the Moon is drifting away', score: 90 })
    seedTopic(db, { title: 'runner-up', score: 70 })
    expect(planTick(db, [testChannel()], { falKeyPresent: true })).toEqual({
      kind: 'produce',
      channel: 'test',
      topicId: best,
      topic: 'Why the Moon is drifting away',
      tier: 'volume',
    })
    db.close()
  })
})

describe('claim pass quota', () => {
  it.each(['queued', 'running', 'failed', 'done'])(
    'a %s job created today consumes its tier slot',
    (status) => {
      const db = openDb(':memory:')
      seedJob(db, { status })
      seedTopic(db)
      const ch = testChannel({ tierMix: { volume: 1, premium: 0 } })
      expect(planTick(db, [ch], { falKeyPresent: true })).toEqual(NOOP)
      db.close()
    },
  )

  it('counts blocked jobs toward the claim quota too', () => {
    const db = openDb(':memory:')
    // Sentinel spend empties GLOBAL headroom so the resume pass skips the
    // blocked job; the claim pass must then see its slot as taken.
    seedJob(db, { status: 'blocked' })
    recordCost(db, 'scout:test', 'anthropic', 'scout-score', 23_500_000)
    seedTopic(db)
    const ch = testChannel({ tierMix: { volume: 1, premium: 0 } })
    expect(planTick(db, [ch], { falKeyPresent: true })).toEqual(NOOP)
    db.close()
  })

  it('ignores jobs from previous UTC days', () => {
    const db = openDb(':memory:')
    seedJob(db, { status: 'failed', createdAt: '2020-01-01T00:00:00.000Z' })
    const topicId = seedTopic(db)
    const ch = testChannel({ tierMix: { volume: 1, premium: 0 } })
    expect(planTick(db, [ch], { falKeyPresent: true })).toMatchObject({
      kind: 'produce',
      topicId,
    })
    db.close()
  })
})

describe('claim pass tier selection', () => {
  it('fills the premium slot first when an approved topic exists', () => {
    const db = openDb(':memory:')
    const approved = seedTopic(db, { title: 'approved pick', score: 60, status: 'approved' })
    seedTopic(db, { title: 'hot candidate', score: 95 })
    expect(planTick(db, [testChannel()], { falKeyPresent: true })).toEqual({
      kind: 'produce',
      channel: 'test',
      topicId: approved,
      topic: 'approved pick',
      tier: 'premium',
    })
    db.close()
  })

  it('falls back to volume when no topic is premium-eligible', () => {
    const db = openDb(':memory:')
    const candidate = seedTopic(db, { title: 'hot candidate', score: 95 })
    expect(planTick(db, [testChannel()], { falKeyPresent: true })).toEqual({
      kind: 'produce',
      channel: 'test',
      topicId: candidate,
      topic: 'hot candidate',
      tier: 'volume',
    })
    db.close()
  })

  it('auto_premium lifts the approval gate', () => {
    const db = openDb(':memory:')
    const candidate = seedTopic(db, { title: 'hot candidate', score: 95 })
    const ch = testChannel({ scout: { ...DEFAULT_SCOUT, autoPremium: true } })
    expect(planTick(db, [ch], { falKeyPresent: true })).toEqual({
      kind: 'produce',
      channel: 'test',
      topicId: candidate,
      topic: 'hot candidate',
      tier: 'premium',
    })
    db.close()
  })

  it('skips premium claims entirely without the FAL key', () => {
    const db = openDb(':memory:')
    const approved = seedTopic(db, { title: 'approved pick', score: 60, status: 'approved' })
    expect(planTick(db, [testChannel()], { falKeyPresent: false })).toEqual({
      kind: 'produce',
      channel: 'test',
      topicId: approved,
      topic: 'approved pick',
      tier: 'volume',
    })
    db.close()
  })

  it('does not claim premium once its slot is filled today', () => {
    const db = openDb(':memory:')
    seedJob(db, { tier: 'premium', status: 'failed' })
    const approved = seedTopic(db, { title: 'approved pick', score: 60, status: 'approved' })
    expect(planTick(db, [testChannel()], { falKeyPresent: true })).toEqual({
      kind: 'produce',
      channel: 'test',
      topicId: approved,
      topic: 'approved pick',
      tier: 'volume',
    })
    db.close()
  })
})

describe('claim pass channel fairness', () => {
  it('prefers the channel with the lowest filled fraction of its mix', () => {
    const db = openDb(':memory:')
    seedJob(db, { channel: 'chan-a' }) // 1 of 2 slots → 0.5
    seedJob(db, { channel: 'chan-b' }) // 1 of 4 slots → 0.25
    seedTopic(db, { channel: 'chan-a', title: 'a topic' })
    const bTopic = seedTopic(db, { channel: 'chan-b', title: 'b topic' })
    const chA = testChannel({ name: 'chan-a', tierMix: { volume: 2, premium: 0 } })
    const chB = testChannel({ name: 'chan-b', tierMix: { volume: 4, premium: 0 } })
    expect(planTick(db, [chA, chB], { falKeyPresent: true })).toMatchObject({
      kind: 'produce',
      channel: 'chan-b',
      topicId: bTopic,
    })
    db.close()
  })

  it('breaks filled-fraction ties by channel name ascending', () => {
    const db = openDb(':memory:')
    seedTopic(db, { channel: 'chan-a', title: 'a topic' })
    seedTopic(db, { channel: 'chan-b', title: 'b topic' })
    const chA = testChannel({ name: 'chan-a', tierMix: { volume: 2, premium: 0 } })
    const chB = testChannel({ name: 'chan-b', tierMix: { volume: 2, premium: 0 } })
    // Reversed input order: the sort, not the argument order, must decide.
    expect(planTick(db, [chB, chA], { falKeyPresent: true })).toMatchObject({
      kind: 'produce',
      channel: 'chan-a',
    })
    db.close()
  })

  it('falls through to the next channel when the fairest one has no topics', () => {
    const db = openDb(':memory:')
    const bTopic = seedTopic(db, { channel: 'chan-b', title: 'b topic' })
    const chA = testChannel({ name: 'chan-a', tierMix: { volume: 2, premium: 0 } })
    const chB = testChannel({ name: 'chan-b', tierMix: { volume: 2, premium: 0 } })
    expect(planTick(db, [chA, chB], { falKeyPresent: true })).toMatchObject({
      kind: 'produce',
      channel: 'chan-b',
      topicId: bTopic,
    })
    db.close()
  })
})

describe('no-fal-key noop reason', () => {
  it('surfaces the missing key when an approved topic waits on a premium-only channel', () => {
    const db = openDb(':memory:')
    // approved → volume-eligible too, but this channel has no volume slots,
    // so the ONLY skipped work was premium work behind the missing key
    seedTopic(db, { title: 'approved pick', score: 60, status: 'approved' })
    const ch = testChannel({ tierMix: { volume: 0, premium: 1 } })
    expect(planTick(db, [ch], { falKeyPresent: false })).toEqual({
      kind: 'noop',
      reason: 'no-fal-key',
    })
    db.close()
  })

  it('stays no-eligible-work when nothing premium was skipped for the key', () => {
    const db = openDb(':memory:')
    expect(planTick(db, [testChannel()], { falKeyPresent: false })).toEqual(NOOP)
    db.close()
  })
})
