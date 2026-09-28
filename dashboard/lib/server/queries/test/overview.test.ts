import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Database } from 'better-sqlite3'
import type { ChannelConfig } from '../../../../../src/config/channel.js'
import { testChannel } from '../../../../../src/testing/channel.js'
import { memDb, seedCost, seedJob, seedLibrary, seedStage } from '../../../../../src/testing/db.js'
import { buildOverview } from '../overview.js'

function channel(name: string, perDayUsdMicros: number): ChannelConfig {
  return testChannel({ name, budget: { perVideoUsdMicros: 500_000, perDayUsdMicros } })
}

const NOW = new Date('2026-07-25T12:00:00Z')

describe('buildOverview', () => {
  let db: Database

  beforeEach(() => {
    db = memDb()
    vi.stubEnv('BRAINROT_GLOBAL_DAILY_USD', '12')
  })

  afterEach(() => {
    db.close()
    vi.unstubAllEnvs()
  })

  it('counts jobs by status', () => {
    seedJob(db, 'j1', { channel: 'space', topic: 'a', status: 'done' })
    seedJob(db, 'j2', { channel: 'space', topic: 'b', status: 'failed' })
    seedJob(db, 'j3', { channel: 'space', topic: 'c', status: 'failed' })
    const data = buildOverview(db, [], NOW)
    expect(data.jobsByStatus).toEqual(
      expect.arrayContaining([
        { status: 'failed', count: 2 },
        { status: 'done', count: 1 },
      ]),
    )
  })

  it('lists failed and blocked jobs with the error from the failing stage', () => {
    seedJob(db, 'j1', { channel: 'space', topic: 'Venus', status: 'failed' })
    seedStage(db, 'j1', 'voice', { status: 'failed', error: 'elevenlabs 401' })
    const data = buildOverview(db, [], NOW)
    expect(data.attention).toEqual([
      {
        id: 'j1',
        channel: 'space',
        topic: 'Venus',
        status: 'failed',
        stage: 'voice',
        error: 'elevenlabs 401',
      },
    ])
  })

  it('includes a blocked job even with no failing stage row', () => {
    // BudgetExceededError marks the job blocked; the stage may be clean.
    seedJob(db, 'j1', { channel: 'space', topic: 'Venus', status: 'blocked' })
    const data = buildOverview(db, [], NOW)
    expect(data.attention).toHaveLength(1)
    expect(data.attention[0]?.status).toBe('blocked')
    expect(data.attention[0]?.stage).toBeNull()
  })

  it('ignores done and running jobs in the attention list', () => {
    seedJob(db, 'j1', { channel: 'space', topic: 'a', status: 'done' })
    seedJob(db, 'j2', { channel: 'space', topic: 'b', status: 'running' })
    expect(buildOverview(db, [], NOW).attention).toEqual([])
  })

  it('counts library rows by state', () => {
    seedJob(db, 'j1', { channel: 'space', topic: 'a', status: 'done' })
    seedLibrary(db, 'j1', { videoPath: 'p', state: 'needs-review' })
    expect(buildOverview(db, [], NOW).libraryByState).toEqual([
      { status: 'needs-review', count: 1 },
    ])
  })

  it('reports global spend against the env cap', () => {
    seedJob(db, 'j1', { channel: 'space', topic: 'a', status: 'done' })
    seedCost(db, 'j1', { provider: 'anthropic', operation: 'script', usdMicros: 250000 })
    const data = buildOverview(db, [], NOW)
    expect(data.globalSpend.spentUsdMicros).toBe(250000)
    expect(data.globalSpend.capUsdMicros).toBe(12_000_000)
  })

  it('reports per-channel spend against each channel cap', () => {
    seedJob(db, 'j1', { channel: 'space', topic: 'a', status: 'done' })
    seedCost(db, 'j1', { provider: 'anthropic', operation: 'script', usdMicros: 250000 })
    const data = buildOverview(db, [channel('space', 2_000_000)], NOW)
    expect(data.channelSpend).toEqual([
      { channel: 'space', spentUsdMicros: 250000, capUsdMicros: 2_000_000 },
    ])
  })

  it('attributes a scout sentinel cost row (no matching jobs row) to unattributedUsdMicros', () => {
    seedJob(db, 'j1', { channel: 'space', topic: 'a', status: 'done' })
    seedCost(db, 'j1', { provider: 'anthropic', operation: 'script', usdMicros: 250000 })
    // Scout sentinel: job_id has no matching jobs row. foreign_keys is OFF
    // in this project by design, so this insert (which mirrors what the
    // real scout does) succeeds.
    seedCost(db, 'scout:space', {
      provider: 'anthropic',
      operation: 'scout-score',
      usdMicros: 15000,
    })
    const data = buildOverview(db, [channel('space', 2_000_000)], NOW)
    expect(data.globalSpend.spentUsdMicros).toBe(265000)
    expect(data.channelSpend).toEqual([
      { channel: 'space', spentUsdMicros: 250000, capUsdMicros: 2_000_000 },
    ])
    expect(data.unattributedUsdMicros).toBe(15000)
  })

  it('reports unattributedUsdMicros as 0, not negative, when every cost row is attributed', () => {
    seedJob(db, 'j1', { channel: 'space', topic: 'a', status: 'done' })
    seedCost(db, 'j1', { provider: 'anthropic', operation: 'script', usdMicros: 250000 })
    const data = buildOverview(db, [channel('space', 2_000_000)], NOW)
    expect(data.unattributedUsdMicros).toBe(0)
  })

  it('flags an expired but unreleased lease', () => {
    db.prepare("INSERT INTO leases (name, holder, expires_at) VALUES ('produce','host-1',?)").run(
      new Date(NOW.getTime() - 60_000).toISOString(),
    )
    db.prepare("INSERT INTO leases (name, holder, expires_at) VALUES ('publish','host-2',?)").run(
      new Date(NOW.getTime() + 60_000).toISOString(),
    )
    const data = buildOverview(db, [], NOW)
    expect(data.leases.find((l) => l.name === 'produce')?.expired).toBe(true)
    expect(data.leases.find((l) => l.name === 'publish')?.expired).toBe(false)
  })
})
