import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Database } from 'better-sqlite3'
import { openDb } from '../db/index.js'
import type { ChannelConfig } from '../config/channel.js'
import { createJob } from './runner.js'
import { testChannel } from '../stages/_testkit.js'
import {
  assertBudget,
  BudgetExceededError,
  channelDaySpentMicros,
  globalDaySpentMicros,
  recordCost,
} from './costs.js'

function tempDb() {
  const dir = mkdtempSync(join(tmpdir(), 'brainrot-costs-'))
  return openDb(join(dir, 'brainrot.db'))
}

// Budget shorthand: testChannel() (Task 5) supplies every non-budget field.
function channel(
  name: string,
  budget: { perVideoUsdMicros: number; premiumPerVideoUsdMicros: number; perDayUsdMicros: number },
): ChannelConfig {
  return testChannel({ name, budget })
}

// Cost rows attribute to a channel through the jobs table (costs has no channel
// column), so every job that carries spend must exist as a real jobs row.
function seedJob(db: Database, ch: ChannelConfig, tier: 'volume' | 'premium' = 'volume'): string {
  return createJob(db, ch, { topic: 'budget test topic', tier })
}

const GENEROUS = 100_000_000 // $100 — never the cap under test

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('recordCost + assertBudget', () => {
  it('records a cost row', () => {
    const db = tempDb()
    recordCost(db, 'job-1', 'anthropic', 'script', 1_500_000)
    const row = db
      .prepare('SELECT job_id, provider, operation, usd_micros FROM costs')
      .get() as { job_id: string; provider: string; operation: string; usd_micros: number }
    expect(row).toEqual({
      job_id: 'job-1',
      provider: 'anthropic',
      operation: 'script',
      usd_micros: 1_500_000,
    })
    db.close()
  })

  it('passes when spend is under every cap', () => {
    const db = tempDb()
    const ch = channel('chan-a', {
      perVideoUsdMicros: 8_000_000,
      premiumPerVideoUsdMicros: 7_000_000,
      perDayUsdMicros: 20_000_000,
    })
    const jobId = seedJob(db, ch)
    recordCost(db, jobId, 'anthropic', 'script', 2_000_000)
    expect(() => assertBudget(db, ch, jobId, 1_000_000, 'volume')).not.toThrow()
    db.close()
  })

  it('throws on a volume per-video breach, naming the per-video cap', () => {
    const db = tempDb()
    const ch = channel('chan-a', {
      perVideoUsdMicros: 8_000_000,
      premiumPerVideoUsdMicros: GENEROUS,
      perDayUsdMicros: GENEROUS,
    })
    const jobId = seedJob(db, ch)
    recordCost(db, jobId, 'anthropic', 'script', 7_500_000)
    // 7.5M + 1M = 8.5M > 8M volume cap
    expect(() => assertBudget(db, ch, jobId, 1_000_000, 'volume')).toThrow(BudgetExceededError)
    expect(() => assertBudget(db, ch, jobId, 1_000_000, 'volume')).toThrow(
      /^per-video budget exceeded/,
    )
    db.close()
  })

  it('premium tier judges the job against the premium per-video cap', () => {
    const db = tempDb()
    const ch = channel('chan-a', {
      perVideoUsdMicros: 1_000_000,
      premiumPerVideoUsdMicros: 7_000_000,
      perDayUsdMicros: GENEROUS,
    })
    const jobId = seedJob(db, ch, 'premium')
    recordCost(db, jobId, 'fal', 'image', 2_000_000)
    // Identical db state, tier argument alone picks the cap (assertBudget uses
    // the tier PARAMETER, not the jobs row): 2M + 1M busts the 1M volume cap
    // but fits the 7M premium cap.
    expect(() => assertBudget(db, ch, jobId, 1_000_000, 'premium')).not.toThrow()
    expect(() => assertBudget(db, ch, jobId, 1_000_000, 'volume')).toThrow(
      /^per-video budget exceeded/,
    )
    db.close()
  })

  it('throws on a premium per-video breach, naming the premium cap', () => {
    const db = tempDb()
    const ch = channel('chan-a', {
      perVideoUsdMicros: GENEROUS,
      premiumPerVideoUsdMicros: 7_000_000,
      perDayUsdMicros: GENEROUS,
    })
    const jobId = seedJob(db, ch, 'premium')
    recordCost(db, jobId, 'fal', 'video', 6_500_000)
    // 6.5M + 1M = 7.5M > 7M premium cap
    expect(() => assertBudget(db, ch, jobId, 1_000_000, 'premium')).toThrow(
      /^premium per-video budget exceeded/,
    )
    db.close()
  })

  // These seed spend via recordCost ('now') and assert in the same tick; the
  // only race is a sub-second UTC-midnight rollover between the two statements
  // — accepted. A 00:00:00Z CI failure here is that race, not a regression.
  it("channel-day cap counts only the channel's own jobs", () => {
    const db = tempDb()
    const chA = channel('chan-a', {
      perVideoUsdMicros: GENEROUS,
      premiumPerVideoUsdMicros: GENEROUS,
      perDayUsdMicros: 10_000_000,
    })
    const chB = channel('chan-b', {
      perVideoUsdMicros: GENEROUS,
      premiumPerVideoUsdMicros: GENEROUS,
      perDayUsdMicros: 10_000_000,
    })
    const jobA1 = seedJob(db, chA)
    const jobA2 = seedJob(db, chA)
    const jobB = seedJob(db, chB)
    recordCost(db, jobA1, 'anthropic', 'script', 6_000_000)
    recordCost(db, jobA2, 'fal', 'image', 3_500_000)
    // chan-a today: 9.5M; + 1M = 10.5M > its 10M channel-day cap
    expect(() => assertBudget(db, chA, jobA2, 1_000_000, 'volume')).toThrow(
      /^channel-day budget exceeded for "chan-a"/,
    )
    // chan-b has spent nothing today: the identical call passes (global day
    // would be 10.5M, well under the $25 default global cap)
    expect(() => assertBudget(db, chB, jobB, 1_000_000, 'volume')).not.toThrow()
    db.close()
  })

  it('global-day cap reads BRAINROT_GLOBAL_DAILY_USD and sums across channels', () => {
    vi.stubEnv('BRAINROT_GLOBAL_DAILY_USD', '5')
    const db = tempDb()
    const chA = channel('chan-a', {
      perVideoUsdMicros: GENEROUS,
      premiumPerVideoUsdMicros: GENEROUS,
      perDayUsdMicros: GENEROUS,
    })
    const chB = channel('chan-b', {
      perVideoUsdMicros: GENEROUS,
      premiumPerVideoUsdMicros: GENEROUS,
      perDayUsdMicros: GENEROUS,
    })
    const jobA = seedJob(db, chA)
    const jobB = seedJob(db, chB)
    recordCost(db, jobA, 'anthropic', 'script', 3_000_000)
    recordCost(db, jobB, 'fal', 'image', 1_500_000)
    // all channels today: 4.5M; + 1M = 5.5M > 5M env cap — trips even though
    // chan-b's own channel-day sum is only 2.5M
    expect(() => assertBudget(db, chB, jobB, 1_000_000, 'volume')).toThrow(
      /^global-day budget exceeded/,
    )
    db.close()
  })

  it('global-day cap defaults to $25 when the env var is unset', () => {
    vi.stubEnv('BRAINROT_GLOBAL_DAILY_USD', undefined) // deterministic even if the shell exports it
    const db = tempDb()
    const ch = channel('chan-a', {
      perVideoUsdMicros: GENEROUS,
      premiumPerVideoUsdMicros: GENEROUS,
      perDayUsdMicros: GENEROUS,
    })
    const jobId = seedJob(db, ch)
    recordCost(db, jobId, 'fal', 'video', 24_500_000)
    // 24.5M + 0.5M == 25M default cap exactly: boundary passes (strict >)
    expect(() => assertBudget(db, ch, jobId, 500_000, 'volume')).not.toThrow()
    // 24.5M + 1M = 25.5M > 25M default cap
    expect(() => assertBudget(db, ch, jobId, 1_000_000, 'volume')).toThrow(
      /^global-day budget exceeded/,
    )
    db.close()
  })

  it('spend from a previous UTC day is invisible to daily caps but counts per-video', () => {
    const db = tempDb()
    const daily = channel('chan-a', {
      perVideoUsdMicros: GENEROUS,
      premiumPerVideoUsdMicros: GENEROUS,
      perDayUsdMicros: 5_000_000,
    })
    const jobId = seedJob(db, daily)
    db.prepare(
      "INSERT INTO costs (job_id, provider, operation, usd_micros, created_at) VALUES (?, 'fal', 'video', ?, '2020-01-01T00:00:00.000Z')",
    ).run(jobId, 4_900_000)
    // 4.9M spent in 2020: today's daily sums are 0, so +1M clears the 5M daily cap
    expect(() => assertBudget(db, daily, jobId, 1_000_000, 'volume')).not.toThrow()
    // ...but the per-video cap is lifetime: 4.9M + 1M busts a 5M per-video cap
    const tight = channel('chan-a', {
      perVideoUsdMicros: 5_000_000,
      premiumPerVideoUsdMicros: GENEROUS,
      perDayUsdMicros: 5_000_000,
    })
    expect(() => assertBudget(db, tight, jobId, 1_000_000, 'volume')).toThrow(
      /^per-video budget exceeded/,
    )
    db.close()
  })

  it('rejects a malformed BRAINROT_GLOBAL_DAILY_USD instead of silently uncapping', () => {
    vi.stubEnv('BRAINROT_GLOBAL_DAILY_USD', 'twenty')
    const db = tempDb()
    const ch = channel('chan-a', {
      perVideoUsdMicros: GENEROUS,
      premiumPerVideoUsdMicros: GENEROUS,
      perDayUsdMicros: GENEROUS,
    })
    const jobId = seedJob(db, ch)
    let caught: unknown
    try {
      assertBudget(db, ch, jobId, 1_000, 'volume')
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(Error)
    // Misconfiguration is a crash (job 'failed'), not a budget outcome ('blocked'):
    // a plain Error, NOT BudgetExceededError, so the runner does not park it.
    expect(caught).not.toBeInstanceOf(BudgetExceededError)
    expect((caught as Error).message).toMatch(/BRAINROT_GLOBAL_DAILY_USD/)
    db.close()
  })

  it('passes at the exact per-video boundary (total + upcoming equals the cap)', () => {
    const db = tempDb()
    const ch = channel('chan-a', {
      perVideoUsdMicros: 8_000_000,
      premiumPerVideoUsdMicros: GENEROUS,
      perDayUsdMicros: 20_000_000,
    })
    const jobId = seedJob(db, ch)
    recordCost(db, jobId, 'anthropic', 'script', 7_000_000)
    // per-video: 7M + 1M == 8M cap; channel-day 8M < 20M; global 8M < 25M default
    expect(() => assertBudget(db, ch, jobId, 1_000_000, 'volume')).not.toThrow()
    db.close()
  })
})

// Same seeded-now caveat as above: a sub-second UTC-midnight rollover between
// recordCost and the assertion is the only race — accepted.
describe('day-spend helpers', () => {
  it('channelDaySpentMicros sums today through the jobs JOIN, per channel', () => {
    const db = tempDb()
    const chA = channel('chan-a', {
      perVideoUsdMicros: GENEROUS,
      premiumPerVideoUsdMicros: GENEROUS,
      perDayUsdMicros: GENEROUS,
    })
    const chB = channel('chan-b', {
      perVideoUsdMicros: GENEROUS,
      premiumPerVideoUsdMicros: GENEROUS,
      perDayUsdMicros: GENEROUS,
    })
    const jobA = seedJob(db, chA)
    const jobB = seedJob(db, chB)
    recordCost(db, jobA, 'anthropic', 'script', 2_000_000)
    recordCost(db, jobA, 'fal', 'image', 500_000)
    recordCost(db, jobB, 'anthropic', 'script', 1_000_000)
    expect(channelDaySpentMicros(db, 'chan-a')).toBe(2_500_000)
    expect(channelDaySpentMicros(db, 'chan-b')).toBe(1_000_000)
    expect(channelDaySpentMicros(db, 'chan-c')).toBe(0)
    db.close()
  })

  it('channelDaySpentMicros ignores previous UTC days and non-job sentinel rows', () => {
    const db = tempDb()
    const ch = channel('chan-a', {
      perVideoUsdMicros: GENEROUS,
      premiumPerVideoUsdMicros: GENEROUS,
      perDayUsdMicros: GENEROUS,
    })
    const jobId = seedJob(db, ch)
    db.prepare(
      "INSERT INTO costs (job_id, provider, operation, usd_micros, created_at) VALUES (?, 'fal', 'video', ?, '2020-01-01T00:00:00.000Z')",
    ).run(jobId, 4_000_000)
    // FKs are off by design: sentinel rows attach to no jobs row, so the
    // channel attribution JOIN drops them.
    recordCost(db, 'scout:chan-a', 'anthropic', 'scout-score', 15_000)
    expect(channelDaySpentMicros(db, 'chan-a')).toBe(0)
    db.close()
  })

  it('globalDaySpentMicros sums ALL of today, sentinel rows included', () => {
    const db = tempDb()
    const ch = channel('chan-a', {
      perVideoUsdMicros: GENEROUS,
      premiumPerVideoUsdMicros: GENEROUS,
      perDayUsdMicros: GENEROUS,
    })
    const jobId = seedJob(db, ch)
    recordCost(db, jobId, 'anthropic', 'script', 2_000_000)
    recordCost(db, 'scout:chan-a', 'anthropic', 'scout-score', 15_000)
    db.prepare(
      "INSERT INTO costs (job_id, provider, operation, usd_micros, created_at) VALUES (?, 'fal', 'video', ?, '2020-01-01T00:00:00.000Z')",
    ).run(jobId, 4_000_000)
    expect(globalDaySpentMicros(db)).toBe(2_015_000)
    db.close()
  })
})
