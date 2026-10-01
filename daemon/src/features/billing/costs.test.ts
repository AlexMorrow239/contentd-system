import { beforeEach, describe, expect, it, vi } from 'vitest'
import { testChannel } from '../../../testing/channel.js'
import { memDb, seedCost, seedJob } from '../../../testing/db.js'
import { createTestTime, type TestTime } from '../../../testing/time.js'
import { ContentdError, classify } from '../../shared/errors.js'
import {
  BudgetExceededError,
  assertBudget,
  channelDaySpentMicros,
  channelDaySpentMicrosByChannel,
  daySpendBreakdown,
  globalDailyCapMicros,
  globalDaySpentMicros,
  recordCost,
} from './costs.js'

let time: TestTime
beforeEach(() => {
  time = createTestTime(new Date('2026-08-01T12:00:00Z'))
  vi.stubEnv('CONTENTD_GLOBAL_DAILY_USD', undefined)
})

describe('assertBudget', () => {
  it.each([
    { scope: 'channel-day', budget: { perDayUsdMicros: 100 }, global: '1' },
    { scope: 'global-day', budget: undefined, global: '0.0001' },
  ] as const)('records structured $scope refusal details', ({ scope, budget, global }) => {
    vi.stubEnv('CONTENTD_GLOBAL_DAILY_USD', global)
    const db = memDb(time)
    const channel = testChannel({ budget })
    seedJob(db, 'job', { channel: channel.name })
    recordCost(db, 'job', 'anthropic', 'script', 80, undefined, time)
    let error: unknown
    try {
      assertBudget(db, channel, 30, time)
    } catch (err) {
      error = err
    }
    expect(error).toMatchObject({
      details: {
        scope,
        upcomingUsdMicros: 30,
        spentUsdMicros: 80,
        capUsdMicros: 100,
        utcDay: '2026-08-01',
      },
    })
  })

  it('uses only the global cap for a channel with no budget, including the exact boundary', () => {
    const db = memDb(time)
    const channel = testChannel()
    seedCost(db, 'scout:other', { usdMicros: 24_500_000 })
    expect(() => assertBudget(db, channel, 500_000, time)).not.toThrow()
    expect(() => assertBudget(db, channel, 500_001, time)).toThrow(/global-day budget/)
  })

  it('counts production and scouting together without borrowing another channel limit', () => {
    const db = memDb(time)
    const a = testChannel({ name: 'a', budget: { perDayUsdMicros: 100 } })
    const b = testChannel({ name: 'b', budget: { perDayUsdMicros: 100 } })
    seedJob(db, 'job', { channel: 'a' })
    db.prepare('UPDATE jobs SET deleted_at = ? WHERE id = ?').run(time.now().toISOString(), 'job')
    seedCost(db, 'job', { usdMicros: 60 })
    seedCost(db, 'scout:a', { usdMicros: 30 })
    expect(() => assertBudget(db, a, 10, time)).not.toThrow()
    expect(() => assertBudget(db, a, 11, time)).toThrow(/channel-day budget/)
    expect(() => assertBudget(db, b, 100, time)).not.toThrow()
    vi.stubEnv('CONTENTD_GLOBAL_DAILY_USD', '0.00015')
    expect(() => assertBudget(db, b, 61, time)).toThrow(/global-day budget/)
  })

  it('has no lifetime video cap and resets daily spend at UTC midnight', () => {
    const db = memDb(time)
    const channel = testChannel({ budget: { perDayUsdMicros: 100 } })
    seedJob(db, 'job', { channel: channel.name })
    seedCost(db, 'job', { usdMicros: 100 })
    expect(() => assertBudget(db, channel, 1, time)).toThrow(BudgetExceededError)
    time.setNow(new Date('2026-08-02T00:00:00.000Z'))
    expect(() => assertBudget(db, channel, 100, time)).not.toThrow()
  })

  it('revalidates a channel limit after the global setting changes', () => {
    const db = memDb(time)
    const channel = testChannel({ name: 'a', budget: { perDayUsdMicros: 2_000_000 } })
    vi.stubEnv('CONTENTD_GLOBAL_DAILY_USD', '2')
    expect(() => assertBudget(db, channel, 1, time)).toThrow(/channel "a".*must be lower/)
  })

  it('zero global budget blocks positive paid work', () => {
    vi.stubEnv('CONTENTD_GLOBAL_DAILY_USD', '0')
    expect(() => assertBudget(memDb(time), testChannel(), 1, time)).toThrow(/global-day budget/)
  })

  it('malformed configuration is a config failure, not a budget wait', () => {
    vi.stubEnv('CONTENTD_GLOBAL_DAILY_USD', 'invalid')
    let error: unknown
    try {
      assertBudget(memDb(time), testChannel(), 1, time)
    } catch (err) {
      error = err
    }
    expect(error).not.toBeInstanceOf(BudgetExceededError)
    expect(classify(error)).toMatchObject({ domain: 'config', kind: 'invalid' })
  })
})

describe('cost accounting', () => {
  it('records the charge and its stage attempt', () => {
    const db = memDb(time)
    recordCost(db, 'job', 'elevenlabs', 'tts', 1500, 'attempt-1', time)
    expect(
      db.prepare('SELECT job_id,provider,operation,usd_micros,attempt_id FROM costs').get(),
    ).toEqual({
      job_id: 'job',
      provider: 'elevenlabs',
      operation: 'tts',
      usd_micros: 1500,
      attempt_id: 'attempt-1',
    })
  })

  it('attributes exact scouting IDs and historical job costs once in both readers', () => {
    const db = memDb(time)
    seedJob(db, 'job', { channel: 'a_%' })
    seedJob(db, 'scout:collision', { channel: 'owner' })
    seedCost(db, 'job', { usdMicros: 10 })
    seedCost(db, 'scout:a_%', { usdMicros: 20 })
    seedCost(db, 'scout:a_other', { usdMicros: 30 })
    seedCost(db, 'scout:collision', { usdMicros: 40 })
    seedCost(db, 'unknown', { usdMicros: 50 })
    seedCost(db, 'scout:a_%', { usdMicros: 999, createdAt: '2026-07-31T12:00:00.000Z' })
    const day = '2026-08-01'
    const totals = channelDaySpentMicrosByChannel(db, day)
    expect(totals).toEqual(
      new Map([
        ['a_%', 30],
        ['a_other', 30],
        ['owner', 40],
      ]),
    )
    for (const [channel, total] of totals)
      expect(channelDaySpentMicros(db, channel, day)).toBe(total)
    expect(channelDaySpentMicros(db, 'missing', day)).toBe(0)
    expect(globalDaySpentMicros(db, day)).toBe(150)
    expect(daySpendBreakdown(db, 7, time)).toEqual([
      { day, micros: 150 },
      { day: '2026-07-31', micros: 999 },
    ])
  })
})

describe('globalDailyCapMicros', () => {
  it.each([undefined, '', '  '])('defaults to $25 for %j', (raw) => {
    vi.stubEnv('CONTENTD_GLOBAL_DAILY_USD', raw)
    expect(globalDailyCapMicros()).toBe(25_000_000)
  })
  it.each(['-1', 'Infinity', 'NaN', 'invalid', '1e100', '0.0000001'])('rejects %s', (raw) => {
    vi.stubEnv('CONTENTD_GLOBAL_DAILY_USD', raw)
    expect(() => globalDailyCapMicros()).toThrow(/CONTENTD_GLOBAL_DAILY_USD/)
  })
  it('uses explicit overrides including zero', () => {
    vi.stubEnv('CONTENTD_GLOBAL_DAILY_USD', '12')
    expect(globalDailyCapMicros()).toBe(12_000_000)
    vi.stubEnv('CONTENTD_GLOBAL_DAILY_USD', '0')
    expect(globalDailyCapMicros()).toBe(0)
  })
})

describe('BudgetExceededError', () => {
  it('retains the job/budget classification', () => {
    const err = new BudgetExceededError('global-day cap exceeded')
    expect(err).toBeInstanceOf(ContentdError)
    expect(classify(err)).toMatchObject({ domain: 'job', kind: 'budget' })
  })
})
