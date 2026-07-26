import { describe, expect, it } from 'vitest'
import type { Database } from 'better-sqlite3'
import { openDb } from '../../db/index.js'
import type { ChannelConfig } from '../../config/channel.js'
import { buildPublishGrids, cellKey } from './publishes.js'

function channel(name: string, slots: string[]): ChannelConfig {
  return {
    name,
    niche: [],
    videosPerDay: slots.length,
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
    budget: { perVideoUsdMicros: 500_000, perDayUsdMicros: 2_000_000 },
    scriptModel: 'claude-sonnet-5',
    scout: { subreddits: [], rss: [], minScore: 60, perSourceLimit: 25 },
    publish: {
      slots,
      platforms: ['youtube'],
      privacy: 'public',
      categoryId: 27,
      madeForKids: false,
    },
  }
}

function seed(): Database {
  const db = openDb(':memory:')
  db.prepare(
    "INSERT INTO jobs (id, channel, tier, topic, status) VALUES ('j1','space','volume','Venus','done')",
  ).run()
  return db
}

describe('buildPublishGrids', () => {
  const now = new Date('2026-07-25T12:00:00')

  it('skips channels with no [publish] table — they never enter the pool', () => {
    const db = seed()
    const noPublish = { ...channel('space', []), publish: null }
    expect(buildPublishGrids(db, [noPublish], 3, now)).toEqual([])
    db.close()
  })

  it('produces one row per configured slot and one column per day, newest day first', () => {
    const db = seed()
    const [grid] = buildPublishGrids(db, [channel('space', ['09:00', '17:00'])], 3, now)
    expect(grid?.slots).toEqual(['09:00', '17:00'])
    expect(grid?.days).toEqual(['2026-07-25', '2026-07-24', '2026-07-23'])
    db.close()
  })

  it('places a publish row in its day/slot cell', () => {
    const db = seed()
    db.prepare(
      'INSERT INTO publishes (job_id, platform, channel, day, slot, status, post_id, url, attempt) ' +
        "VALUES ('j1','youtube','space','2026-07-25','09:00','done','abc','https://y/abc',1)",
    ).run()
    const [grid] = buildPublishGrids(db, [channel('space', ['09:00', '17:00'])], 3, now)
    const cell = grid?.cells.get(cellKey('2026-07-25', '09:00'))
    expect(cell?.status).toBe('done')
    expect(cell?.url).toBe('https://y/abc')
    db.close()
  })

  it('leaves an unfilled slot absent from the map, so the view can show a gap', () => {
    // The grid comes from channel config, not from the publishes table — a
    // slot that was never filled must be visible as a gap, not omitted.
    const db = seed()
    const [grid] = buildPublishGrids(db, [channel('space', ['09:00'])], 2, now)
    expect(grid?.cells.get(cellKey('2026-07-25', '09:00'))).toBeUndefined()
    expect(grid?.days).toContain('2026-07-25')
    db.close()
  })

  it('ignores publish rows outside the requested window', () => {
    const db = seed()
    db.prepare(
      'INSERT INTO publishes (job_id, platform, channel, day, slot, status, attempt) ' +
        "VALUES ('j1','youtube','space','2026-01-01','09:00','done',1)",
    ).run()
    const [grid] = buildPublishGrids(db, [channel('space', ['09:00'])], 2, now)
    expect(grid?.cells.size).toBe(0)
    db.close()
  })

  it('keeps channels separate', () => {
    const db = seed()
    db.prepare(
      'INSERT INTO publishes (job_id, platform, channel, day, slot, status, attempt) ' +
        "VALUES ('j1','youtube','space','2026-07-25','09:00','done',1)",
    ).run()
    const grids = buildPublishGrids(
      db,
      [channel('space', ['09:00']), channel('ocean', ['09:00'])],
      1,
      now,
    )
    expect(grids.find((g) => g.channel === 'space')?.cells.size).toBe(1)
    expect(grids.find((g) => g.channel === 'ocean')?.cells.size).toBe(0)
    db.close()
  })
})
