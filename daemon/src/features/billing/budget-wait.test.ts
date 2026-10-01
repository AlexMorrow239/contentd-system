import { beforeEach, describe, expect, it, vi } from 'vitest'
import { testChannel } from '../../../testing/channel.js'
import { memDb, seedCost, seedJob } from '../../../testing/db.js'
import { budgetWaitEligible, makeBudgetWait } from './budget-wait.js'
import { BudgetExceededError } from './costs.js'

const now = new Date('2026-09-29T12:00:00.000Z')
const tomorrow = new Date('2026-09-30T00:00:00.000Z')
const channel = testChannel({ budget: { perDayUsdMicros: 100 } })
function wait(upcoming = 30) {
  return JSON.stringify(
    makeBudgetWait(
      new BudgetExceededError('over cap', {
        scope: 'channel-day',
        upcomingUsdMicros: upcoming,
        spentUsdMicros: 80,
        capUsdMicros: 100,
        utcDay: '2026-09-29',
      }),
      channel,
      'script',
      now,
    ),
  )
}

beforeEach(() => vi.stubEnv('CONTENTD_GLOBAL_DAILY_USD', '0.0003'))

describe('budgetWaitEligible', () => {
  it('reads historical per-video refusals without enforcing the retired cap', () => {
    const db = memDb()
    seedJob(db, 'job', { channel: channel.name })
    seedCost(db, 'job', { usdMicros: 80, createdAt: now.toISOString() })
    const current = testChannel({ budget: { perDayUsdMicros: 200 } })
    const legacy = makeBudgetWait(
      new BudgetExceededError('old per-video limit'),
      current,
      'voice',
      now,
    )
    const raw = JSON.stringify({
      ...legacy,
      details: {
        scope: 'per-video',
        upcomingUsdMicros: 30,
        spentUsdMicros: 80,
        capUsdMicros: 100,
        utcDay: legacy.utcDay,
      },
    })
    expect(budgetWaitEligible(db, current, raw, now)).toBe(true)
    expect(budgetWaitEligible(db, { ...current, budget: undefined }, raw, now)).toBe(true)
  })
  it('can persist a custom refusal with malformed global configuration and detect its repair', () => {
    vi.stubEnv('CONTENTD_GLOBAL_DAILY_USD', 'invalid')
    const db = memDb()
    const raw = JSON.stringify(
      makeBudgetWait(new BudgetExceededError('provider refusal'), channel, 'voice', now),
    )
    expect(budgetWaitEligible(db, channel, raw, now)).toBe(false)
    vi.stubEnv('CONTENTD_GLOBAL_DAILY_USD', '0.0003')
    expect(budgetWaitEligible(db, channel, raw, now)).toBe(true)
  })

  it('persists unstructured tagged-budget reasons without losing the wait', () => {
    const db = memDb()
    const wait = makeBudgetWait('provider budget refusal', channel, 'voice', now)
    expect(wait.reason).toBe('provider budget refusal')
    expect(wait.details).toBeNull()
    expect(budgetWaitEligible(db, channel, JSON.stringify(wait), now)).toBe(false)
  })

  it('lets a legacy job probe, then parks an unstructured refusal until config or day changes', () => {
    const db = memDb()
    expect(budgetWaitEligible(db, channel, null, now)).toBe(true)
    const raw = JSON.stringify(
      makeBudgetWait(new BudgetExceededError('unknown cap'), channel, 'script', now),
    )
    expect(budgetWaitEligible(db, channel, raw, now)).toBe(false)
    expect(budgetWaitEligible(db, channel, raw, tomorrow)).toBe(true)
    expect(budgetWaitEligible(db, { ...channel, scriptModel: 'cheaper' }, raw, now)).toBe(true)
  })

  it('releases daily spend after UTC midnight', () => {
    const db = memDb()
    seedJob(db, 'job', { channel: channel.name })
    seedCost(db, 'job', { usdMicros: 80, createdAt: now.toISOString() })
    expect(budgetWaitEligible(db, channel, wait(), now)).toBe(false)
    expect(budgetWaitEligible(db, channel, wait(), tomorrow)).toBe(true)
  })

  it('allows the precise projected boundary with headroom far below the old floor', () => {
    const db = memDb()
    seedJob(db, 'job', { channel: channel.name })
    seedCost(db, 'job', { usdMicros: 70, createdAt: now.toISOString() })
    expect(budgetWaitEligible(db, channel, wait(), now)).toBe(true)
  })

  it.each([
    { jobId: 'other', spent: 180, cap: 'channel-day' },
    { jobId: 'scout:test', spent: 280, cap: 'global-day' },
  ])('rechecks the $cap cap and unlocks after UTC rollover', ({ jobId, spent }) => {
    const db = memDb()
    seedJob(db, 'job', { channel: channel.name })
    if (jobId === 'other') seedJob(db, jobId, { channel: channel.name })
    seedCost(db, jobId, { usdMicros: spent, createdAt: now.toISOString() })
    expect(budgetWaitEligible(db, channel, wait(), now)).toBe(false)
    expect(budgetWaitEligible(db, channel, wait(), tomorrow)).toBe(true)
  })

  it('permits a config-change probe even when the old estimate no longer fits', () => {
    const db = memDb()
    const raw = wait(101)
    expect(budgetWaitEligible(db, channel, raw, now)).toBe(false)
    const changed = { ...channel, voice: { ...channel.voice, voiceId: 'another-voice' } }
    expect(budgetWaitEligible(db, changed, raw, now)).toBe(true)
    const reparking = JSON.stringify(
      makeBudgetWait(
        new BudgetExceededError('still too much', {
          scope: 'channel-day',
          upcomingUsdMicros: 101,
          spentUsdMicros: 0,
          capUsdMicros: 100,
          utcDay: '2026-09-29',
        }),
        changed,
        'voice',
        now,
      ),
    )
    expect(budgetWaitEligible(db, changed, reparking, now)).toBe(false)
  })

  it('fingerprints global budget changes and ignores config object key order', () => {
    const db = memDb()
    const raw = wait(101)
    const reordered = Object.fromEntries(Object.entries(channel).reverse()) as typeof channel
    expect(budgetWaitEligible(db, reordered, raw, now)).toBe(false)
    vi.stubEnv('CONTENTD_GLOBAL_DAILY_USD', '0.0004')
    expect(budgetWaitEligible(db, channel, raw, now)).toBe(true)
  })

  it('allows malformed legacy metadata to be repaired by one fresh probe', () => {
    const db = memDb()
    expect(budgetWaitEligible(db, channel, '{invalid', now)).toBe(true)
  })
})
