import { describe, expect, it } from 'vitest'
import type { Database } from 'better-sqlite3'
import { openDb } from '../../db/index.js'
import type { ChannelConfig } from '../../config/channel.js'
import type { PublishTargetConfig } from '../../publish/types.js'
import { buildPublishGrids, cellKey } from './publishes.js'

function channelWithTargets(
  name: string,
  videosPerDay: number,
  targets: PublishTargetConfig[],
): ChannelConfig {
  return {
    name,
    niche: [],
    videosPerDay,
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

function channel(name: string, videosPerDay: number): ChannelConfig {
  return channelWithTargets(name, videosPerDay, [
    {
      platform: 'youtube',
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
    const noPublish = { ...channel('space', 1), publish: null }
    expect(buildPublishGrids(db, [noPublish], 3, now)).toEqual([])
    db.close()
  })

  it('produces one row per videos_per_day ordinal and one column per day, newest day first', () => {
    const db = seed()
    const [grid] = buildPublishGrids(db, [channel('space', 2)], 3, now)
    expect(grid?.rows).toEqual([
      { platform: 'youtube', seq: 1 },
      { platform: 'youtube', seq: 2 },
    ])
    expect(grid?.days).toEqual(['2026-07-25', '2026-07-24', '2026-07-23'])
    db.close()
  })

  it('places a publish row in its day/seq/platform cell', () => {
    const db = seed()
    db.prepare(
      'INSERT INTO publishes (job_id, platform, channel, day, seq, status, post_id, url, attempt) ' +
        "VALUES ('j1','youtube','space','2026-07-25',1,'done','abc','https://y/abc',1)",
    ).run()
    const [grid] = buildPublishGrids(db, [channel('space', 2)], 3, now)
    const cell = grid?.cells.get(cellKey('2026-07-25', 1, 'youtube'))
    expect(cell?.status).toBe('done')
    expect(cell?.url).toBe('https://y/abc')
    db.close()
  })

  it('leaves an unreached ordinal absent from the map, so the view can show a gap', () => {
    // The grid comes from channel config, not from the publishes table — an
    // attempt that never happened must be visible as a gap, not omitted.
    const db = seed()
    const [grid] = buildPublishGrids(db, [channel('space', 1)], 2, now)
    expect(grid?.cells.get(cellKey('2026-07-25', 1, 'youtube'))).toBeUndefined()
    expect(grid?.days).toContain('2026-07-25')
    db.close()
  })

  it('ignores publish rows outside the requested window', () => {
    const db = seed()
    db.prepare(
      'INSERT INTO publishes (job_id, platform, channel, day, seq, status, attempt) ' +
        "VALUES ('j1','youtube','space','2026-01-01',1,'done',1)",
    ).run()
    const [grid] = buildPublishGrids(db, [channel('space', 1)], 2, now)
    expect(grid?.cells.size).toBe(0)
    db.close()
  })

  it('gives every platform its own row at every ordinal, sorted by ordinal then platform', () => {
    const db = seed()
    const multi = channelWithTargets('space', 3, [
      {
        platform: 'youtube',
        options: { privacy: 'public', categoryId: 27, madeForKids: false },
      },
      {
        platform: 'instagram',
        options: { igUserId: 'ig1', shareToFeed: true },
      },
    ])
    const [grid] = buildPublishGrids(db, [multi], 1, now)
    expect(grid?.rows).toEqual([
      { platform: 'instagram', seq: 1 },
      { platform: 'youtube', seq: 1 },
      { platform: 'instagram', seq: 2 },
      { platform: 'youtube', seq: 2 },
      { platform: 'instagram', seq: 3 },
      { platform: 'youtube', seq: 3 },
    ])
    db.close()
  })

  it('keeps channels separate', () => {
    const db = seed()
    db.prepare(
      'INSERT INTO publishes (job_id, platform, channel, day, seq, status, attempt) ' +
        "VALUES ('j1','youtube','space','2026-07-25',1,'done',1)",
    ).run()
    const grids = buildPublishGrids(db, [channel('space', 1), channel('ocean', 1)], 1, now)
    expect(grids.find((g) => g.channel === 'space')?.cells.size).toBe(1)
    expect(grids.find((g) => g.channel === 'ocean')?.cells.size).toBe(0)
    db.close()
  })

  it('regression: two platforms at the same ordinal each keep their own row and cell', () => {
    // A cross-posting channel writes the same ordinal on both platforms (they
    // are separate UNIQUE partitions), so without a platform-aware cellKey and
    // row model the second-inserted platform's row would overwrite the first's.
    const db = seed()
    db.prepare(
      'INSERT INTO publishes (job_id, platform, channel, day, seq, status, post_id, url, attempt) ' +
        "VALUES ('j1','youtube','space','2026-07-25',1,'done','yt1','https://y/yt1',1)",
    ).run()
    db.prepare(
      'INSERT INTO publishes (job_id, platform, channel, day, seq, status, error, error_kind, attempt) ' +
        "VALUES ('j1','instagram','space','2026-07-25',1,'failed','boom','transient',1)",
    ).run()

    const crossPosting = channelWithTargets('space', 1, [
      {
        platform: 'youtube',
        options: { privacy: 'public', categoryId: 27, madeForKids: false },
      },
      {
        platform: 'instagram',
        options: { igUserId: 'ig1', shareToFeed: true },
      },
    ])
    const [grid] = buildPublishGrids(db, [crossPosting], 1, now)

    expect(grid?.rows).toEqual([
      { platform: 'instagram', seq: 1 },
      { platform: 'youtube', seq: 1 },
    ])
    expect(grid?.cells.size).toBe(2)

    const youtubeCell = grid?.cells.get(cellKey('2026-07-25', 1, 'youtube'))
    expect(youtubeCell?.status).toBe('done')
    expect(youtubeCell?.url).toBe('https://y/yt1')

    const instagramCell = grid?.cells.get(cellKey('2026-07-25', 1, 'instagram'))
    expect(instagramCell?.status).toBe('failed')
    expect(instagramCell?.error).toBe('boom')
    db.close()
  })
})
