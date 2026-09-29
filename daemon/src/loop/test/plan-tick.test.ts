import { createTestTime, type TestTime } from '../../../testing/time.js'
let time: TestTime
beforeEach(() => {
  time = createTestTime(new Date('2026-08-01T12:00:00Z'))
})
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Database } from 'better-sqlite3'
import { BudgetExceededError, recordCost } from '../../jobs/costs.js'
import { makeBudgetWait } from '../../jobs/budget-wait.js'
import { testChannel } from '../../../testing/channel.js'
import { planTick } from '../plan-tick.js'
import {
  memDb,
  seedJob as seedJobRow,
  seedLibrary,
  seedTopic as seedTopicRow,
} from '../../../testing/db.js'

const NOOP = { kind: 'noop', reason: 'no-eligible-work' } as const

// planTick only SELECTs, so these wrappers exist for call-shape convenience
// (auto-numbered ids, plan-tick's own defaults) over the shared row builders in
// daemon/testing/db.ts, which own the SQL. seedJob defaults created_at to now (UTC
// today) — the claim-pass quota only counts today's rows; explicit createdAt
// pins ordering where it matters.
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
  const id = overrides.id ?? `job-${jobSeq}`
  seedJobRow(db, id, {
    channel: overrides.channel ?? 'test',
    topic: `topic for ${id}`,
    status: overrides.status ?? 'done',
    createdAt: overrides.createdAt ?? time.now().toISOString(),
  })
  return id
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
  return seedTopicRow(db, {
    channel: overrides.channel ?? 'test',
    title: overrides.title ?? `Topic ${topicSeq}`,
    rawTitle: `raw ${topicSeq}`,
    source: 'reddit:r/space',
    url: `https://example.com/${topicSeq}`,
    dedupeHash: `hash-${topicSeq}`,
    score: overrides.score ?? 80,
    reason: 'seeded',
    status: overrides.status ?? 'candidate',
    jobId: overrides.jobId ?? null,
    createdAt: overrides.createdAt ?? '2026-07-01T00:00:00.000Z',
  })
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
  it('noops when there are no blocked jobs and no topics', () => {
    const db = memDb(time)
    expect(planTick(db, [testChannel()], time)).toEqual(NOOP)
    db.close()
  })
})

describe('resume pass', () => {
  it('beats the claim pass when a blocked job is eligible', () => {
    const db = memDb(time)
    seedJob(db, { id: 'job-parked', status: 'blocked' })
    seedTopic(db) // a claimable topic must not outrank the parked job
    expect(planTick(db, [testChannel()], time)).toEqual({
      kind: 'resume',
      jobId: 'job-parked',
      channel: 'test',
    })
    db.close()
  })

  it('takes the oldest blocked job first', () => {
    const db = memDb(time)
    seedJob(db, { id: 'job-newer', status: 'blocked', createdAt: '2026-07-02T00:00:00.000Z' })
    seedJob(db, { id: 'job-older', status: 'blocked', createdAt: '2026-07-01T00:00:00.000Z' })
    expect(planTick(db, [testChannel()], time)).toMatchObject({
      kind: 'resume',
      jobId: 'job-older',
    })
    db.close()
  })

  it('skips a blocked job whose channel is missing and takes the next oldest', () => {
    const db = memDb(time)
    // Oldest blocked job belongs to a channel whose TOML left the dir.
    seedJob(db, {
      id: 'job-ghost',
      channel: 'ghost',
      status: 'blocked',
      createdAt: '2026-07-01T00:00:00.000Z',
    })
    seedJob(db, { id: 'job-live', status: 'blocked', createdAt: '2026-07-02T00:00:00.000Z' })
    expect(planTick(db, [testChannel()], time)).toMatchObject({
      kind: 'resume',
      jobId: 'job-live',
    })
    db.close()
  })
})

describe('resume eligibility', () => {
  it('parks a known unaffordable next call despite positive per-video headroom', () => {
    const db = memDb(time)
    const ch = testChannel()
    seedJob(db, { id: 'job-capped', status: 'blocked' })
    recordCost(db, 'job-capped', 'anthropic', 'script', 7_000_000)
    const wait = makeBudgetWait(
      new BudgetExceededError('over cap', {
        scope: 'per-video',
        upcomingUsdMicros: 1_500_000,
        spentUsdMicros: 7_000_000,
        capUsdMicros: 8_000_000,
        utcDay: time.now().toISOString().slice(0, 10),
      }),
      ch,
      'voice',
      time.now(),
    )
    db.prepare('UPDATE jobs SET budget_wait_json = ? WHERE id = ?').run(
      JSON.stringify(wait),
      'job-capped',
    )
    const topicId = seedTopic(db)
    expect(planTick(db, [ch], time)).toMatchObject({ kind: 'produce', topicId })
  })

  it('resumes an affordable next call with less than the obsolete headroom floor', () => {
    const db = memDb(time)
    const ch = testChannel()
    seedJob(db, { id: 'job-parked', status: 'blocked' })
    recordCost(db, 'job-parked', 'anthropic', 'script', 7_500_000)
    const wait = makeBudgetWait(
      new BudgetExceededError('old day exhausted', {
        scope: 'channel-day',
        upcomingUsdMicros: 500_000,
        spentUsdMicros: 20_000_000,
        capUsdMicros: 20_000_000,
        utcDay: '2020-01-01',
      }),
      ch,
      'voice',
      time.now(),
    )
    db.prepare('UPDATE jobs SET budget_wait_json = ? WHERE id = ?').run(
      JSON.stringify(wait),
      'job-parked',
    )
    expect(planTick(db, [ch], time)).toMatchObject({ kind: 'resume', jobId: 'job-parked' })
  })

  it('selects due recovery work before older blocked jobs without writing the plan', () => {
    const db = memDb(time)
    seedJob(db, { id: 'blocked', status: 'blocked', createdAt: '2020-01-01T00:00:00.000Z' })
    seedJob(db, { id: 'recovery', status: 'queued' })
    db.prepare('UPDATE jobs SET recovery_pending = 1, retry_after = ? WHERE id = ?').run(
      '2020-01-01T00:00:00.000Z',
      'recovery',
    )
    db.pragma('query_only = ON')
    expect(planTick(db, [testChannel()], time)).toEqual({
      kind: 'resume',
      jobId: 'recovery',
      channel: 'test',
    })
  })

  it.each(['queued', 'blocked'])('skips a %s job before its retry deadline', (status) => {
    const db = memDb(time)
    const jobId = seedJob(db, { status })
    db.prepare('UPDATE jobs SET recovery_pending = 1, retry_after = ? WHERE id = ?').run(
      '2999-01-01T00:00:00.000Z',
      jobId,
    )
    const topicId = seedTopic(db)
    expect(planTick(db, [testChannel()], time)).toMatchObject({ kind: 'produce', topicId })
  })

  it('skips an ordinary queued job and a recovery job whose channel was removed', () => {
    const db = memDb(time)
    seedJob(db, { id: 'ordinary', status: 'queued' })
    seedJob(db, { id: 'ghost', status: 'queued', channel: 'ghost' })
    db.prepare('UPDATE jobs SET recovery_pending = 1 WHERE id = ?').run('ghost')
    const topicId = seedTopic(db)
    expect(planTick(db, [testChannel()], time)).toMatchObject({ kind: 'produce', topicId })
  })
})

describe('claim pass', () => {
  it('claims the best eligible topic', () => {
    const db = memDb(time)
    const best = seedTopic(db, { title: 'Why the Moon is drifting away', score: 90 })
    seedTopic(db, { title: 'runner-up', score: 70 })
    expect(planTick(db, [testChannel()], time)).toEqual({
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
      const db = memDb(time)
      seedJob(db, { status })
      seedTopic(db)
      const ch = testChannel({ videosPerDay: 1 })
      expect(planTick(db, [ch], time)).toEqual(NOOP)
      db.close()
    },
  )

  it('counts blocked jobs toward the claim quota too', () => {
    const db = memDb(time)
    const jobId = seedJob(db, { status: 'blocked' })
    seedTopic(db)
    const ch = testChannel({ videosPerDay: 1 })
    db.prepare('UPDATE jobs SET budget_wait_json = ? WHERE id = ?').run(
      JSON.stringify(
        makeBudgetWait(new BudgetExceededError('unknown cap'), ch, 'script', time.now()),
      ),
      jobId,
    )
    expect(planTick(db, [ch], time)).toEqual(NOOP)
    db.close()
  })

  it('ignores jobs from previous UTC days', () => {
    const db = memDb(time)
    seedJob(db, { status: 'failed', createdAt: '2020-01-01T00:00:00.000Z' })
    const topicId = seedTopic(db)
    const ch = testChannel({ videosPerDay: 1 })
    expect(planTick(db, [ch], time)).toMatchObject({
      kind: 'produce',
      topicId,
    })
    db.close()
  })
})

describe('claim pass channel fairness', () => {
  it('prefers the channel with the lowest filled fraction of its daily quota', () => {
    const db = memDb(time)
    seedJob(db, { channel: 'chan-a' }) // 1 of 2 slots → 0.5
    seedJob(db, { channel: 'chan-b' }) // 1 of 4 slots → 0.25
    seedTopic(db, { channel: 'chan-a', title: 'a topic' })
    const bTopic = seedTopic(db, { channel: 'chan-b', title: 'b topic' })
    const chA = testChannel({ name: 'chan-a', videosPerDay: 2 })
    const chB = testChannel({ name: 'chan-b', videosPerDay: 4 })
    expect(planTick(db, [chA, chB], time)).toMatchObject({
      kind: 'produce',
      channel: 'chan-b',
      topicId: bTopic,
    })
    db.close()
  })

  it('breaks filled-fraction ties by channel name ascending', () => {
    const db = memDb(time)
    seedTopic(db, { channel: 'chan-a', title: 'a topic' })
    seedTopic(db, { channel: 'chan-b', title: 'b topic' })
    const chA = testChannel({ name: 'chan-a', videosPerDay: 2 })
    const chB = testChannel({ name: 'chan-b', videosPerDay: 2 })
    // Reversed input order: the sort, not the argument order, must decide.
    expect(planTick(db, [chB, chA], time)).toMatchObject({
      kind: 'produce',
      channel: 'chan-a',
    })
    db.close()
  })

  it('falls through to the next channel when the fairest one has no topics', () => {
    const db = memDb(time)
    const bTopic = seedTopic(db, { channel: 'chan-b', title: 'b topic' })
    const chA = testChannel({ name: 'chan-a', videosPerDay: 2 })
    const chB = testChannel({ name: 'chan-b', videosPerDay: 2 })
    expect(planTick(db, [chA, chB], time)).toMatchObject({
      kind: 'produce',
      channel: 'chan-b',
      topicId: bTopic,
    })
    db.close()
  })
})

describe('claim pass backlog gate', () => {
  it('skips a channel already holding its full backlog', () => {
    const db = memDb(time)
    const channel = testChannel({ name: 'chan-a', videosPerDay: 2, backlogDays: 2 })
    seedTopic(db, { channel: 'chan-a', status: 'candidate' })
    for (const id of ['job-1', 'job-2', 'job-3', 'job-4']) {
      seedJob(db, { id, channel: 'chan-a', createdAt: '2026-07-26T00:00:00.000Z' })
      seedLibrary(db, id, { state: 'ready', createdAt: '2026-07-26T00:00:00.000Z' })
    }

    expect(planTick(db, [channel], time)).toEqual({ kind: 'noop', reason: 'backlog-full' })
    db.close()
  })

  it('produces when the backlog is one short of the cap', () => {
    const db = memDb(time)
    const channel = testChannel({ name: 'chan-a', videosPerDay: 2, backlogDays: 2 })
    const topicId = seedTopic(db, { channel: 'chan-a', status: 'candidate' })
    for (const id of ['job-1', 'job-2', 'job-3']) {
      seedJob(db, { id, channel: 'chan-a', createdAt: '2026-07-26T00:00:00.000Z' })
      seedLibrary(db, id, { state: 'ready', createdAt: '2026-07-26T00:00:00.000Z' })
    }

    const plan = planTick(db, [channel], time)

    expect(plan.kind).toBe('produce')
    expect((plan as { topicId: number }).topicId).toBe(topicId)
    db.close()
  })

  it.each(['blocked', 'queued'])('waits to resume a %s job on a backlogged channel', (status) => {
    const db = memDb(time)
    const channel = testChannel({ name: 'chan-a', videosPerDay: 2, backlogDays: 2 })
    seedJob(db, { id: 'job-blocked', channel: 'chan-a', status })
    db.prepare('UPDATE jobs SET recovery_pending = 1 WHERE id = ?').run('job-blocked')
    for (const id of ['job-1', 'job-2', 'job-3', 'job-4']) {
      seedJob(db, { id, channel: 'chan-a', createdAt: '2026-07-26T00:00:00.000Z' })
      seedLibrary(db, id, { state: 'ready', createdAt: '2026-07-26T00:00:00.000Z' })
    }

    expect(planTick(db, [channel], time)).toEqual({
      kind: 'noop',
      reason: 'backlog-full',
    })
    db.close()
  })
})
