import { describe, expect, it } from 'vitest'
import { localDay } from '../publish/schedule.js'
import { memDb } from '../testing/db.js'
import { testChannel } from '../testing/channel.js'
import { buildDigest } from './digest.js'
import {
  DAY_MS,
  HOUR_MS,
  isoAgo,
  publishChannel,
  seedJob,
  seedLibrary,
  seedPublish,
} from './_digest.fixtures.js'

/**
 * The Publishing section: its body, its action items, the ready backlog and
 * the volume-shortfall item.
 *
 * Split from a single 964-line digest.test.ts whose fifteen describes already
 * mapped 1:1 onto sections of the digest's output. Shared seeds live in
 * _digest.fixtures.ts.
 */

describe('buildDigest — publishing section', () => {
  it('lists a published video with its resolved title and url', () => {
    const db = memDb()
    seedJob(db, { id: 'j-pub', channel: 'chan-a' })
    db.prepare(
      "INSERT INTO library (job_id, video_path, metadata_json, state) VALUES (?, '/tmp/out.mp4', ?, 'published')",
    ).run(
      'j-pub',
      JSON.stringify({ youtube: { title: 'Moon Facts', description: 'd', hashtags: [] } }),
    )
    seedPublish(db, {
      jobId: 'j-pub',
      channel: 'chan-a',
      seq: 1,
      status: 'done',
      url: 'https://youtube.com/shorts/abc123',
    })
    const digest = buildDigest(db, [])
    expect(digest).toContain('Publishing (last 24h)')
    expect(digest).toContain('  Published:')
    expect(digest).toContain('    chan-a #1 "Moon Facts" — https://youtube.com/shorts/abc123')
    db.close()
  })

  it('lists a failed attempt with its error kind and truncates the error to 80 chars', () => {
    const db = memDb()
    const longError = 'x'.repeat(120)
    seedPublish(db, {
      jobId: 'j-fail',
      channel: 'chan-b',
      seq: 2,
      status: 'failed',
      errorKind: 'rejected',
      error: longError,
    })
    const digest = buildDigest(db, [])
    expect(digest).toContain(`    chan-b #2 rejected: ${'x'.repeat(80)}`)
    expect(digest).not.toContain('x'.repeat(81))
    db.close()
  })

  it('prints none for both subsections when nothing published or failed in the last 24h', () => {
    const db = memDb()
    const digest = buildDigest(db, [])
    expect(digest).toContain('  Published:\n    none')
    expect(digest).toContain('  Failed:\n    none')
    db.close()
  })

  it('excludes publishes older than 24h', () => {
    const db = memDb()
    seedJob(db, { id: 'j-old', channel: 'chan-a' })
    db.prepare(
      "INSERT INTO library (job_id, video_path, metadata_json, state) VALUES ('j-old', '/tmp/out.mp4', '{}', 'published')",
    ).run()
    seedPublish(db, {
      jobId: 'j-old',
      channel: 'chan-a',
      status: 'done',
      url: 'https://youtube.com/shorts/old',
      createdAt: isoAgo(3 * DAY_MS),
    })
    const digest = buildDigest(db, [])
    expect(digest).toContain('  Published:\n    none')
    db.close()
  })
})

describe('buildDigest — publishing action items', () => {
  it('flags channels with auth failures in the last 24h, one line per channel', () => {
    const db = memDb()
    seedPublish(db, {
      jobId: 'j1',
      channel: 'chan-a',
      seq: 1,
      status: 'failed',
      errorKind: 'auth',
    })
    seedPublish(db, {
      jobId: 'j2',
      channel: 'chan-a',
      seq: 2,
      status: 'failed',
      errorKind: 'auth',
    })
    const digest = buildDigest(db, [])
    expect(digest).toContain(
      '  chan-a youtube: 2 auth failures in the last 24h — run brainrot auth youtube --channel chan-a',
    )
    db.close()
  })

  it('flags quota failures distinctly — the cap estimate and reality disagree', () => {
    const db = memDb()
    seedPublish(db, {
      jobId: 'j1',
      channel: 'chan-a',
      seq: 1,
      status: 'failed',
      errorKind: 'quota',
    })
    seedPublish(db, {
      jobId: 'j2',
      channel: 'chan-a',
      seq: 2,
      status: 'failed',
      errorKind: 'quota',
    })
    const digest = buildDigest(db, [])
    expect(digest).toContain(
      '  chan-a youtube: 2 quota failures in the last 24h — the platform refused the upload; check BRAINROT_YT_UPLOADS_PER_DAY against the real quota',
    )
    db.close()
  })

  it('instructs checking Studio for interrupted uploads of any age', () => {
    const db = memDb()
    seedPublish(db, {
      jobId: 'j-int',
      channel: 'chan-a',
      seq: 3,
      status: 'interrupted',
      createdAt: isoAgo(3 * DAY_MS),
    })
    const digest = buildDigest(db, [])
    expect(digest).toContain(
      '  interrupted publish j-int (chan-a, youtube, #3) — check YouTube Studio, then brainrot publish retry j-int or brainrot publish mark-done j-int <postId>',
    )
    db.close()
  })

  it('suggests library reject for a job at the rejected attempt cap while still ready', () => {
    const db = memDb()
    seedJob(db, { id: 'j-capped', channel: 'chan-a' })
    seedLibrary(db, 'j-capped', 'ready')
    seedPublish(db, {
      jobId: 'j-capped',
      channel: 'chan-a',
      day: '2026-07-19',
      seq: 1,
      status: 'failed',
      errorKind: 'rejected',
    })
    seedPublish(db, {
      jobId: 'j-capped',
      channel: 'chan-a',
      day: '2026-07-19',
      seq: 2,
      status: 'failed',
      errorKind: 'rejected',
    })
    seedPublish(db, {
      jobId: 'j-capped',
      channel: 'chan-a',
      day: '2026-07-19',
      seq: 3,
      status: 'failed',
      errorKind: 'rejected',
    })
    const digest = buildDigest(db, [])
    expect(digest).toContain(
      '  job j-capped (chan-a) hit the publish attempt cap (3 rejected) — run brainrot library reject j-capped',
    )
    db.close()
  })

  it('does not flag a job under the attempt cap', () => {
    const db = memDb()
    seedJob(db, { id: 'j-under', channel: 'chan-a' })
    seedLibrary(db, 'j-under', 'ready')
    seedPublish(db, {
      jobId: 'j-under',
      channel: 'chan-a',
      day: '2026-07-19',
      seq: 1,
      status: 'failed',
      errorKind: 'rejected',
    })
    seedPublish(db, {
      jobId: 'j-under',
      channel: 'chan-a',
      day: '2026-07-19',
      seq: 2,
      status: 'failed',
      errorKind: 'rejected',
    })
    const digest = buildDigest(db, [])
    expect(digest).not.toContain('publish attempt cap')
    db.close()
  })
})

describe('buildDigest — ready-backlog in the Publishing section', () => {
  it('reports ready backlog depth and oldest age inside Publishing (not Action items), publishing channels only', () => {
    const db = memDb()
    const chA = testChannel({
      name: 'chan-a',
      publish: {
        targets: [
          {
            platform: 'youtube',
            options: { privacy: 'public', categoryId: 24, madeForKids: false },
          },
        ],
      },
    })
    const chB = testChannel({ name: 'chan-b', publish: null })
    seedJob(db, { id: 'j-old', channel: 'chan-a' })
    seedLibrary(db, 'j-old', 'ready', isoAgo(5 * HOUR_MS))
    seedJob(db, { id: 'j-new', channel: 'chan-a' })
    seedLibrary(db, 'j-new', 'ready', isoAgo(HOUR_MS))
    seedJob(db, { id: 'j-nopublish', channel: 'chan-b' })
    seedLibrary(db, 'j-nopublish', 'ready')
    const digest = buildDigest(db, [chA, chB])
    expect(digest).toContain('  Backlog:')
    const backlogLine = '    chan-a: 2 ready videos backlogged, oldest 5h old'
    expect(digest).toContain(backlogLine)
    expect(digest).not.toContain('chan-b: 1 ready videos backlogged')
    // The backlog line lives in Publishing (last 24h), before Action items —
    // never under Action items where a lone ready video would stand daily.
    const backlogIdx = digest.indexOf(backlogLine)
    expect(backlogIdx).toBeGreaterThan(digest.indexOf('Publishing (last 24h)'))
    expect(backlogIdx).toBeLessThan(digest.indexOf('Action items'))
    db.close()
  })

  it('labels the backlog subsection and falls back to none when no channel has a ready backlog', () => {
    const db = memDb()
    const digest = buildDigest(db, [])
    expect(digest).toContain('  Backlog:\n    none')
    db.close()
  })
})

describe('buildDigest — volume-shortfall action item', () => {
  it('reports a channel that published fewer videos than videos_per_day yesterday, split per platform', () => {
    const db = memDb()
    // Mirror the impl's own local field math (new Date(now); setDate(-1);
    // localDay) — now-minus-24h lands on the wrong local date across a DST
    // transition and would diverge from the digest in that window.
    const yesterdayDate = new Date()
    yesterdayDate.setDate(yesterdayDate.getDate() - 1)
    const yesterday = localDay(yesterdayDate)
    const chA = testChannel({
      name: 'chan-a',
      videosPerDay: 3,
      // Declared instagram-first because that is the order buildTargets
      // emits (sorted by platform), and the per-platform split follows it.
      publish: {
        targets: [
          { platform: 'instagram', options: { igUserId: 'ig-1', shareToFeed: true } },
          {
            platform: 'youtube',
            options: { privacy: 'public', categoryId: 24, madeForKids: false },
          },
        ],
      },
    })
    seedJob(db, { id: 'j-yday', channel: 'chan-a' })
    seedPublish(db, {
      jobId: 'j-yday',
      channel: 'chan-a',
      day: yesterday,
      seq: 1,
      status: 'done',
    })
    const digest = buildDigest(db, [chA])
    expect(digest).toContain(
      `  chan-a: published 1 of 3 videos yesterday (${yesterday}) — instagram 0, youtube 1`,
    )
    db.close()
  })

  it('says nothing when the channel met its count', () => {
    const db = memDb()
    const yesterdayDate = new Date()
    yesterdayDate.setDate(yesterdayDate.getDate() - 1)
    const yesterday = localDay(yesterdayDate)
    const chA = publishChannel('chan-a', { videosPerDay: 1 })
    seedJob(db, { id: 'j-yday', channel: 'chan-a' })
    seedPublish(db, {
      jobId: 'j-yday',
      channel: 'chan-a',
      day: yesterday,
      seq: 1,
      status: 'done',
    })
    const digest = buildDigest(db, [chA])
    expect(digest).not.toContain('videos yesterday')
    db.close()
  })

  it('does not report a shortfall for a channel with no publish config', () => {
    const db = memDb()
    const chB = testChannel({ name: 'chan-b', publish: null })
    const digest = buildDigest(db, [chB])
    expect(digest).not.toContain('videos yesterday')
    db.close()
  })
})
