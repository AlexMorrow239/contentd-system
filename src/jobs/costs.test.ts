import { describe, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from '../db/index.js'
import type { ChannelConfig } from '../config/channel.js'
import { assertBudget, BudgetExceededError, recordCost } from './costs.js'

function tempDb() {
  const dir = mkdtempSync(join(tmpdir(), 'brainrot-costs-'))
  return openDb(join(dir, 'brainrot.db'))
}

function channel(perVideoUsdMicros: number, perDayUsdMicros: number): ChannelConfig {
  return {
    name: 'test',
    niche: ['x'],
    tierMix: { volume: 1, premium: 0 },
    voice: { volume: 'af_heart' },
    premium: { imageModel: 'fal-ai/flux/dev', videoModel: 'fal-ai/kling-video/v3/standard/image-to-video', sceneConcurrency: 3 },
    captionStyle: {
      font: 'Inter',
      fontSizePx: 72,
      activeColor: '#FFD700',
      inactiveColor: '#FFFFFF',
      strokePx: 8,
    },
    bgDir: 'assets/bg',
    bgmDir: 'assets/bgm',
    budget: { perVideoUsdMicros, premiumPerVideoUsdMicros: 7_000_000, perDayUsdMicros },
    scriptModel: 'claude-sonnet-5',
  }
}

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

  it('passes when job total + upcoming is under the per-video cap', () => {
    const db = tempDb()
    recordCost(db, 'job-1', 'anthropic', 'script', 2_000_000)
    expect(() =>
      assertBudget(db, channel(8_000_000, 20_000_000), 'job-1', 1_000_000),
    ).not.toThrow()
    db.close()
  })

  it('throws on a per-video breach', () => {
    const db = tempDb()
    recordCost(db, 'job-1', 'anthropic', 'script', 7_500_000)
    expect(() =>
      assertBudget(db, channel(8_000_000, 20_000_000), 'job-1', 1_000_000),
    ).toThrow(BudgetExceededError)
    db.close()
  })

  it('throws on a per-day breach across two jobs', () => {
    const db = tempDb()
    // per-video cap is generous so only the per-day cap can trip
    recordCost(db, 'job-1', 'anthropic', 'script', 12_000_000)
    recordCost(db, 'job-2', 'fal', 'visuals', 7_000_000)
    // job-3 has no prior spend, but the day already holds 19M across all jobs
    expect(() =>
      assertBudget(db, channel(100_000_000, 20_000_000), 'job-3', 2_000_000),
    ).toThrow(BudgetExceededError)
    db.close()
  })

  it('passes at the exact boundary (total + upcoming equals the cap)', () => {
    const db = tempDb()
    recordCost(db, 'job-1', 'anthropic', 'script', 7_000_000)
    // per-video: 7_000_000 + 1_000_000 == 8_000_000 cap; per-day 8_000_000 < 20_000_000
    expect(() =>
      assertBudget(db, channel(8_000_000, 20_000_000), 'job-1', 1_000_000),
    ).not.toThrow()
    db.close()
  })
})
