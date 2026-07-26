import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Database } from 'better-sqlite3'
import { openDb } from '../../db/index.js'
import type { ChannelConfig } from '../../config/channel.js'
import { buildOverview } from './overview.js'

function channel(name: string, perDayUsdMicros: number): ChannelConfig {
  return {
    name,
    niche: [],
    videosPerDay: 2,
    voice: { volume: 'af_heart' },
    captionStyle: {
      font: 'Inter',
      fontSizePx: 80,
      activeColor: '#fff',
      inactiveColor: '#888',
      strokePx: 8,
    },
    bgDir: [],
    bgmDir: '',
    budget: { perVideoUsdMicros: 500_000, perDayUsdMicros },
    scriptModel: 'claude-sonnet-5',
    scout: { subreddits: [], rss: [], minScore: 60, perSourceLimit: 25 },
    publish: null,
  }
}

const NOW = new Date('2026-07-25T12:00:00Z')

describe('buildOverview', () => {
  let db: Database

  beforeEach(() => {
    db = openDb(':memory:')
    process.env.BRAINROT_GLOBAL_DAILY_USD = '12'
  })

  afterEach(() => {
    db.close()
    delete process.env.BRAINROT_GLOBAL_DAILY_USD
  })

  it('counts jobs by status', () => {
    db.prepare(
      "INSERT INTO jobs (id, channel, tier, topic, status) VALUES ('j1','space','volume','a','done')",
    ).run()
    db.prepare(
      "INSERT INTO jobs (id, channel, tier, topic, status) VALUES ('j2','space','volume','b','failed')",
    ).run()
    db.prepare(
      "INSERT INTO jobs (id, channel, tier, topic, status) VALUES ('j3','space','volume','c','failed')",
    ).run()
    const data = buildOverview(db, [], NOW, 6)
    expect(data.jobsByStatus).toEqual(
      expect.arrayContaining([
        { status: 'failed', count: 2 },
        { status: 'done', count: 1 },
      ]),
    )
  })

  it('lists failed and blocked jobs with the error from the failing stage', () => {
    db.prepare(
      "INSERT INTO jobs (id, channel, tier, topic, status) VALUES ('j1','space','volume','Venus','failed')",
    ).run()
    db.prepare(
      "INSERT INTO job_stages (job_id, stage, status, error) VALUES ('j1','voice','failed','elevenlabs 401')",
    ).run()
    const data = buildOverview(db, [], NOW, 6)
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
    db.prepare(
      "INSERT INTO jobs (id, channel, tier, topic, status) VALUES ('j1','space','volume','Venus','blocked')",
    ).run()
    const data = buildOverview(db, [], NOW, 6)
    expect(data.attention).toHaveLength(1)
    expect(data.attention[0]?.status).toBe('blocked')
    expect(data.attention[0]?.stage).toBeNull()
  })

  it('ignores done and running jobs in the attention list', () => {
    db.prepare(
      "INSERT INTO jobs (id, channel, tier, topic, status) VALUES ('j1','space','volume','a','done')",
    ).run()
    db.prepare(
      "INSERT INTO jobs (id, channel, tier, topic, status) VALUES ('j2','space','volume','b','running')",
    ).run()
    expect(buildOverview(db, [], NOW, 6).attention).toEqual([])
  })

  it('counts library rows by state', () => {
    db.prepare(
      "INSERT INTO jobs (id, channel, tier, topic, status) VALUES ('j1','space','volume','a','done')",
    ).run()
    db.prepare(
      "INSERT INTO library (job_id, video_path, metadata_json, state) VALUES ('j1','p','{}','needs-review')",
    ).run()
    expect(buildOverview(db, [], NOW, 6).libraryByState).toEqual([
      { status: 'needs-review', count: 1 },
    ])
  })

  it('reports global spend against the env cap', () => {
    db.prepare(
      "INSERT INTO jobs (id, channel, tier, topic, status) VALUES ('j1','space','volume','a','done')",
    ).run()
    db.prepare(
      "INSERT INTO costs (job_id, provider, operation, usd_micros) VALUES ('j1','anthropic','script',250000)",
    ).run()
    const data = buildOverview(db, [], NOW, 6)
    expect(data.globalSpend.spentUsdMicros).toBe(250000)
    expect(data.globalSpend.capUsdMicros).toBe(12_000_000)
  })

  it('reports per-channel spend against each channel cap', () => {
    db.prepare(
      "INSERT INTO jobs (id, channel, tier, topic, status) VALUES ('j1','space','volume','a','done')",
    ).run()
    db.prepare(
      "INSERT INTO costs (job_id, provider, operation, usd_micros) VALUES ('j1','anthropic','script',250000)",
    ).run()
    const data = buildOverview(db, [channel('space', 2_000_000)], NOW, 6)
    expect(data.channelSpend).toEqual([
      { channel: 'space', spentUsdMicros: 250000, capUsdMicros: 2_000_000 },
    ])
  })

  it('flags an expired but unreleased lease', () => {
    db.prepare("INSERT INTO leases (name, holder, expires_at) VALUES ('produce','host-1',?)").run(
      new Date(NOW.getTime() - 60_000).toISOString(),
    )
    db.prepare("INSERT INTO leases (name, holder, expires_at) VALUES ('publish','host-2',?)").run(
      new Date(NOW.getTime() + 60_000).toISOString(),
    )
    const data = buildOverview(db, [], NOW, 6)
    expect(data.leases.find((l) => l.name === 'produce')?.expired).toBe(true)
    expect(data.leases.find((l) => l.name === 'publish')?.expired).toBe(false)
  })

  it('passes the quota cap through and counts today uploads', () => {
    db.prepare(
      "INSERT INTO jobs (id, channel, tier, topic, status) VALUES ('j1','space','volume','a','done')",
    ).run()
    db.prepare(
      "INSERT INTO publishes (job_id, platform, channel, day, slot, status, attempt) " +
        "VALUES ('j1','youtube','space','2026-07-25','09:00','done',1)",
    ).run()
    const data = buildOverview(db, [], new Date('2026-07-25T12:00:00'), 6)
    expect(data.quotaUsed).toBe(1)
    expect(data.quotaCap).toBe(6)
  })
})
