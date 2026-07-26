import { describe, expect, it } from 'vitest'
import type { Database } from 'better-sqlite3'
import { openDb } from '../../db/index.js'
import type { ChannelConfig } from '../../config/channel.js'
import type { PublishTargetConfig } from '../../publish/types.js'
import { buildPublishGrids, cellKey } from './publishes.js'

function channelWithTargets(name: string, targets: PublishTargetConfig[]): ChannelConfig {
  return {
    name,
    niche: [],
    videosPerDay: targets.reduce((sum, t) => sum + t.slots.length, 0),
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
    publish: { targets },
  }
}

function channel(name: string, slots: string[]): ChannelConfig {
  return channelWithTargets(name, [
    {
      platform: 'youtube',
      slots,
      options: { privacy: 'public', categoryId: 27, madeForKids: false },
    },
  ])
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
    expect(grid?.rows).toEqual([
      { platform: 'youtube', slot: '09:00' },
      { platform: 'youtube', slot: '17:00' },
    ])
    expect(grid?.days).toEqual(['2026-07-25', '2026-07-24', '2026-07-23'])
    db.close()
  })

  it('places a publish row in its day/slot/platform cell', () => {
    const db = seed()
    db.prepare(
      'INSERT INTO publishes (job_id, platform, channel, day, slot, status, post_id, url, attempt) ' +
        "VALUES ('j1','youtube','space','2026-07-25','09:00','done','abc','https://y/abc',1)",
    ).run()
    const [grid] = buildPublishGrids(db, [channel('space', ['09:00', '17:00'])], 3, now)
    const cell = grid?.cells.get(cellKey('2026-07-25', '09:00', 'youtube'))
    expect(cell?.status).toBe('done')
    expect(cell?.url).toBe('https://y/abc')
    db.close()
  })

  it('leaves an unfilled slot absent from the map, so the view can show a gap', () => {
    // The grid comes from channel config, not from the publishes table — a
    // slot that was never filled must be visible as a gap, not omitted.
    const db = seed()
    const [grid] = buildPublishGrids(db, [channel('space', ['09:00'])], 2, now)
    expect(grid?.cells.get(cellKey('2026-07-25', '09:00', 'youtube'))).toBeUndefined()
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

  it('gives every platform its own row, sorted by slot then platform, even with different times', () => {
    const db = seed()
    const multi = channelWithTargets('space', [
      {
        platform: 'youtube',
        slots: ['10:00', '14:00', '19:00'],
        options: { privacy: 'public', categoryId: 27, madeForKids: false },
      },
      {
        platform: 'instagram',
        slots: ['11:00', '14:00'],
        options: { igUserId: 'ig1', shareToFeed: true },
      },
    ])
    const [grid] = buildPublishGrids(db, [multi], 1, now)
    expect(grid?.rows).toEqual([
      { platform: 'youtube', slot: '10:00' },
      { platform: 'instagram', slot: '11:00' },
      { platform: 'instagram', slot: '14:00' },
      { platform: 'youtube', slot: '14:00' },
      { platform: 'youtube', slot: '19:00' },
    ])
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

  it('regression: two platforms sharing the same slot time each keep their own row and cell', () => {
    // This is the exact scenario from the shared `[publish] slots = [...]`
    // configuration (see channels/test.toml): both targets declare the same
    // slot times, so without a platform-aware cellKey and row model the
    // second-inserted platform's row would overwrite the first's.
    const db = seed()
    db.prepare(
      'INSERT INTO publishes (job_id, platform, channel, day, slot, status, post_id, url, attempt) ' +
        "VALUES ('j1','youtube','space','2026-07-25','10:00','done','yt1','https://y/yt1',1)",
    ).run()
    db.prepare(
      'INSERT INTO publishes (job_id, platform, channel, day, slot, status, error, error_kind, attempt) ' +
        "VALUES ('j1','instagram','space','2026-07-25','10:00','failed','boom','transient',1)",
    ).run()

    const sharedSlots = channelWithTargets('space', [
      {
        platform: 'youtube',
        slots: ['10:00'],
        options: { privacy: 'public', categoryId: 27, madeForKids: false },
      },
      {
        platform: 'instagram',
        slots: ['10:00'],
        options: { igUserId: 'ig1', shareToFeed: true },
      },
    ])
    const [grid] = buildPublishGrids(db, [sharedSlots], 1, now)

    expect(grid?.rows).toEqual([
      { platform: 'instagram', slot: '10:00' },
      { platform: 'youtube', slot: '10:00' },
    ])
    expect(grid?.cells.size).toBe(2)

    const youtubeCell = grid?.cells.get(cellKey('2026-07-25', '10:00', 'youtube'))
    expect(youtubeCell?.status).toBe('done')
    expect(youtubeCell?.url).toBe('https://y/yt1')

    const instagramCell = grid?.cells.get(cellKey('2026-07-25', '10:00', 'instagram'))
    expect(instagramCell?.status).toBe('failed')
    expect(instagramCell?.error).toBe('boom')
    db.close()
  })
})
