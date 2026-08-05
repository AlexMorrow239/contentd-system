import { describe, expect, it } from 'vitest'
import type { Database } from 'better-sqlite3'
import {
  candidateTopicCount,
  claimedTopicCount,
  claimTopic,
  eligibleTopic,
  insertTopics,
  knownHashes,
  listTopics,
  markTopicUsedByJob,
  RECENT_TITLES_LIMIT,
  recentTopicTitles,
  redditCandidates,
  rejectTopics,
  requeueTopic,
  setTopicTargetUrl,
  storyPartForJob,
} from '../topics.js'
import { memDb, seedJob, seedTopic as kitSeedTopic } from '../../testing/db.js'
import type { TopicRow } from '../../testing/db.js'

// Local ergonomics over the shared row builder: a per-call sequence keeps
// repeated bare seeds distinct under UNIQUE (channel, dedupe_hash), and
// created_at is pinned so ordering assertions are not clock-dependent. Row
// SQL is the testkit's (the _digest.fixtures.ts pattern).
let seq = 0
function seedTopic(db: Database, overrides: Partial<TopicRow> = {}): number {
  seq += 1
  return kitSeedTopic(db, {
    title: `Topic ${String(seq)}`,
    rawTitle: `Raw ${String(seq)}`,
    source: 'reddit:r/space',
    url: `https://example.com/${String(seq)}`,
    dedupeHash: `hash-${String(seq)}`,
    score: 50,
    createdAt: '2026-07-20T00:00:00.000Z',
    ...overrides,
  })
}

describe('topics table schema', () => {
  it('creates the table with candidate default and UNIQUE (channel, dedupe_hash)', () => {
    const db = memDb()
    db.prepare(
      "INSERT INTO topics (channel, title, raw_title, source, url, dedupe_hash, score, reason) VALUES ('chan-a', 'T', 'R', 's', 'u', 'h1', 80, 'r')",
    ).run()
    const row = db.prepare('SELECT status, job_id, created_at FROM topics').get() as {
      status: string
      job_id: string | null
      created_at: string
    }
    expect(row.status).toBe('candidate')
    expect(row.job_id).toBeNull()
    expect(row.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    // same (channel, dedupe_hash) is ignored; same hash on another channel inserts
    const dup = db
      .prepare(
        "INSERT OR IGNORE INTO topics (channel, title, raw_title, source, url, dedupe_hash, score, reason) VALUES ('chan-a', 'T2', 'R2', 's', 'u', 'h1', 10, 'r')",
      )
      .run()
    expect(dup.changes).toBe(0)
    const other = db
      .prepare(
        "INSERT OR IGNORE INTO topics (channel, title, raw_title, source, url, dedupe_hash, score, reason) VALUES ('chan-b', 'T', 'R', 's', 'u', 'h1', 80, 'r')",
      )
      .run()
    expect(other.changes).toBe(1)
    db.close()
  })

  it('rejects a status outside the lifecycle CHECK', () => {
    const db = memDb()
    expect(() => seedTopic(db, { status: 'simmering' })).toThrow(/CHECK/)
    // 'approved' was a valid status under the old premium-tier lifecycle;
    // it is no longer part of the CHECK.
    expect(() => seedTopic(db, { status: 'approved' })).toThrow(/CHECK/)
    db.close()
  })
})

describe('insertTopics', () => {
  it('inserts a batch and reports only rows actually written', () => {
    const db = memDb()
    const base = {
      title: 'Why the Moon is drifting away',
      rawTitle: 'Moon drifting 3.8cm/yr',
      source: 'reddit:r/space',
      url: 'https://www.reddit.com/r/space/1',
      score: 82,
      reason: 'high novelty',
    }
    const first = insertTopics(db, [
      { ...base, channel: 'chan-a', dedupeHash: 'h1', status: 'candidate' },
      { ...base, channel: 'chan-a', dedupeHash: 'h2', status: 'rejected' },
    ])
    expect(first).toBe(2)
    // re-run overlap: h1 already known, h3 is new
    const second = insertTopics(db, [
      { ...base, channel: 'chan-a', dedupeHash: 'h1', status: 'candidate' },
      { ...base, channel: 'chan-a', dedupeHash: 'h3', status: 'candidate' },
    ])
    expect(second).toBe(1)
    const rows = db.prepare('SELECT dedupe_hash, status FROM topics ORDER BY id').all() as {
      dedupe_hash: string
      status: string
    }[]
    expect(rows).toEqual([
      { dedupe_hash: 'h1', status: 'candidate' },
      { dedupe_hash: 'h2', status: 'rejected' },
      { dedupe_hash: 'h3', status: 'candidate' },
    ])
    db.close()
  })

  it('returns 0 for an empty batch', () => {
    const db = memDb()
    expect(insertTopics(db, [])).toBe(0)
    db.close()
  })
})

describe('knownHashes', () => {
  it('returns only hashes already stored for that channel', () => {
    const db = memDb()
    seedTopic(db, { channel: 'chan-a', dedupeHash: 'h1' })
    // rejected rows are still "known" — they must never reach the scorer again
    seedTopic(db, { channel: 'chan-a', dedupeHash: 'h2', status: 'rejected' })
    seedTopic(db, { channel: 'chan-b', dedupeHash: 'h3' })
    expect(knownHashes(db, 'chan-a', ['h1', 'h2', 'h3', 'h9'])).toEqual(new Set(['h1', 'h2']))
    expect(knownHashes(db, 'chan-a', [])).toEqual(new Set())
    db.close()
  })
})

describe('recentTopicTitles', () => {
  it('returns non-rejected titles newest first, capped at the limit', () => {
    const db = memDb()
    seedTopic(db, { title: 'oldest', createdAt: '2026-07-18T00:00:00.000Z' })
    seedTopic(db, { title: 'skipped', createdAt: '2026-07-19T00:00:00.000Z', status: 'rejected' })
    seedTopic(db, { title: 'middle', createdAt: '2026-07-19T12:00:00.000Z', status: 'used' })
    seedTopic(db, {
      title: 'newest',
      createdAt: '2026-07-20T00:00:00.000Z',
      status: 'claimed',
      jobId: 'job-1',
    })
    seedTopic(db, {
      title: 'other channel',
      channel: 'chan-b',
      createdAt: '2026-07-20T06:00:00.000Z',
    })
    expect(recentTopicTitles(db, 'chan-a')).toEqual(['newest', 'middle', 'oldest'])
    expect(recentTopicTitles(db, 'chan-a', 2)).toEqual(['newest', 'middle'])
    db.close()
  })

  it('defaults the limit to RECENT_TITLES_LIMIT (30)', () => {
    const db = memDb()
    expect(RECENT_TITLES_LIMIT).toBe(30)
    for (let i = 0; i < 35; i++) {
      seedTopic(db, { createdAt: `2026-07-19T00:00:${String(i).padStart(2, '0')}.000Z` })
    }
    expect(recentTopicTitles(db, 'chan-a')).toHaveLength(30)
    db.close()
  })

  it('collapses a story series to one representative title, but counts topic rows individually', () => {
    const db = memDb()
    seedTopic(db, { title: 'Topic A', createdAt: '2026-07-19T00:00:00.000Z' })
    seedTopic(db, { title: 'Topic B', createdAt: '2026-07-19T01:00:00.000Z' })
    seedTopic(db, {
      title: 'Story (1/4)',
      seriesKey: 'S',
      partIndex: 1,
      partCount: 4,
      createdAt: '2026-07-19T02:00:00.000Z',
    })
    seedTopic(db, {
      title: 'Story (2/4)',
      seriesKey: 'S',
      partIndex: 2,
      partCount: 4,
      status: 'used',
      createdAt: '2026-07-19T03:00:00.000Z',
    })
    seedTopic(db, {
      title: 'Story (3/4)',
      seriesKey: 'S',
      partIndex: 3,
      partCount: 4,
      createdAt: '2026-07-19T04:00:00.000Z',
    })
    seedTopic(db, {
      title: 'Story (4/4)',
      seriesKey: 'S',
      partIndex: 4,
      partCount: 4,
      createdAt: '2026-07-19T05:00:00.000Z',
    })
    // One 4-part story plus two topic-mode rows -> three entries, not five.
    const titles = recentTopicTitles(db, 'chan-a')
    expect(titles).toHaveLength(3)
    expect(titles).toEqual(expect.arrayContaining(['Story', 'Topic A', 'Topic B']))
    db.close()
  })

  it('shifts the series representative when its lowest part is rejected', () => {
    const db = memDb()
    seedTopic(db, {
      title: 'Story (1/2)',
      seriesKey: 'S',
      partIndex: 1,
      partCount: 2,
      status: 'rejected',
    })
    seedTopic(db, { title: 'Story (2/2)', seriesKey: 'S', partIndex: 2, partCount: 2 })
    expect(recentTopicTitles(db, 'chan-a')).toEqual(['Story'])
    db.close()
  })

  // includeRejected exists for the llm generator's own avoid-list
  // (src/scout/scout.ts) — the opposite need from the scorer's window above.
  it('includes rejected titles only when includeRejected is set', () => {
    const db = memDb()
    seedTopic(db, { title: 'kept', createdAt: '2026-07-19T00:00:00.000Z' })
    seedTopic(db, {
      title: 'sub-80 rejected topic',
      status: 'rejected',
      createdAt: '2026-07-19T01:00:00.000Z',
    })
    expect(recentTopicTitles(db, 'chan-a')).not.toContain('sub-80 rejected topic')
    expect(recentTopicTitles(db, 'chan-a', RECENT_TITLES_LIMIT, { includeRejected: true })).toEqual(
      expect.arrayContaining(['sub-80 rejected topic', 'kept']),
    )
    db.close()
  })

  it('keeps series-collapse behavior intact when includeRejected is set', () => {
    const db = memDb()
    seedTopic(db, {
      title: 'Story (1/2)',
      seriesKey: 'S',
      partIndex: 1,
      partCount: 2,
      status: 'rejected',
      createdAt: '2026-07-19T00:00:00.000Z',
    })
    seedTopic(db, {
      title: 'Story (2/2)',
      seriesKey: 'S',
      partIndex: 2,
      partCount: 2,
      createdAt: '2026-07-19T01:00:00.000Z',
    })
    // Non-rejected view: the rejected part 1 is skipped, part 2 represents.
    expect(recentTopicTitles(db, 'chan-a')).toEqual(['Story'])
    // includeRejected view: part 1 is eligible again and becomes the (lower
    // part_index) representative — still one collapsed entry, not two.
    expect(recentTopicTitles(db, 'chan-a', RECENT_TITLES_LIMIT, { includeRejected: true })).toEqual(
      ['Story'],
    )
    db.close()
  })
})

describe('candidateTopicCount', () => {
  it('counts only candidate rows for that channel', () => {
    const db = memDb()
    seedTopic(db, { channel: 'chan-a', status: 'candidate', dedupeHash: 'c1' })
    seedTopic(db, { channel: 'chan-a', status: 'candidate', dedupeHash: 'c2' })
    seedTopic(db, { channel: 'chan-a', status: 'rejected', dedupeHash: 'c3' })
    seedTopic(db, { channel: 'chan-a', status: 'used', dedupeHash: 'c4' })
    seedTopic(db, { channel: 'chan-a', status: 'claimed', dedupeHash: 'c5', jobId: 'job-1' })
    seedTopic(db, { channel: 'chan-b', status: 'candidate', dedupeHash: 'c6' })
    expect(candidateTopicCount(db, 'chan-a')).toBe(2)
    expect(candidateTopicCount(db, 'chan-b')).toBe(1)
    expect(candidateTopicCount(db, 'chan-c')).toBe(0)
    db.close()
  })
})

describe('claimedTopicCount', () => {
  it('counts only claimed rows for that channel', () => {
    const db = memDb()
    seedTopic(db, { channel: 'chan-a', status: 'claimed', dedupeHash: 'k1', jobId: 'job-1' })
    seedTopic(db, { channel: 'chan-a', status: 'claimed', dedupeHash: 'k2', jobId: 'job-2' })
    seedTopic(db, { channel: 'chan-a', status: 'candidate', dedupeHash: 'k3' })
    seedTopic(db, { channel: 'chan-a', status: 'used', dedupeHash: 'k4', jobId: 'job-3' })
    seedTopic(db, { channel: 'chan-b', status: 'claimed', dedupeHash: 'k5', jobId: 'job-4' })
    expect(claimedTopicCount(db, 'chan-a')).toBe(2)
    expect(claimedTopicCount(db, 'chan-b')).toBe(1)
    expect(claimedTopicCount(db, 'chan-c')).toBe(0)
    db.close()
  })
})

describe('redditCandidates', () => {
  it('takes reddit candidates with no target yet, in id order', () => {
    const db = memDb()
    const first = seedTopic(db, { source: 'reddit:r/space', dedupeHash: 'r1' })
    const second = seedTopic(db, { source: 'reddit:r/space', dedupeHash: 'r2' })
    seedTopic(db, { source: 'rss:phys.org', dedupeHash: 'r3' })
    seedTopic(db, { source: 'reddit:r/space', dedupeHash: 'r4', status: 'used', jobId: 'job-1' })
    expect(redditCandidates(db, 'chan-a').map((r) => r.id)).toEqual([first, second])
    db.close()
  })

  it('skips a row already carrying a target, which the prune pass cannot re-verdict', () => {
    const db = memDb()
    const untargeted = seedTopic(db, { source: 'reddit:r/space', dedupeHash: 'r1' })
    const targeted = seedTopic(db, { source: 'reddit:r/space', dedupeHash: 'r2' })
    setTopicTargetUrl(db, targeted, 'https://www.theguardian.com/science/x')
    expect(redditCandidates(db, 'chan-a').map((r) => r.id)).toEqual([untargeted])
    db.close()
  })
})

describe('rejectTopics', () => {
  it('reject flips candidate only, leaves claimed/used alone, and reports the changed count', () => {
    const db = memDb()
    const a = seedTopic(db) // candidate
    const b = seedTopic(db, { status: 'claimed', jobId: 'job-1' })
    const c = seedTopic(db, { status: 'used' })
    // b and c are not candidates and 9999 does not exist: all silently skipped
    expect(rejectTopics(db, [a, b, c, 9999])).toBe(1)
    const statuses = db.prepare('SELECT id, status FROM topics ORDER BY id').all() as {
      id: number
      status: string
    }[]
    expect(statuses).toEqual([
      { id: a, status: 'rejected' },
      { id: b, status: 'claimed' },
      { id: c, status: 'used' },
    ])
    expect(rejectTopics(db, [])).toBe(0)
    db.close()
  })
})

describe('claimTopic / markTopicUsedByJob', () => {
  it('claim binds the topic to its job and reports success', () => {
    const db = memDb()
    const id = seedTopic(db) // candidate
    expect(claimTopic(db, id, 'job-42')).toBe(true)
    const row = db.prepare('SELECT status, job_id FROM topics WHERE id = ?').get(id) as {
      status: string
      job_id: string | null
    }
    expect(row).toEqual({ status: 'claimed', job_id: 'job-42' })
    db.close()
  })

  it('claim never revives a rejected, used, or already-claimed topic', () => {
    const db = memDb()
    for (const status of ['rejected', 'used', 'claimed'] as const) {
      const id = seedTopic(db, { status, jobId: 'job-old' })
      expect(claimTopic(db, id, 'job-new')).toBe(false)
      const row = db.prepare('SELECT status, job_id FROM topics WHERE id = ?').get(id) as {
        status: string
        job_id: string | null
      }
      expect(row).toEqual({ status, job_id: 'job-old' })
    }
    db.close()
  })

  it('markTopicUsedByJob flips only the claimed row with that job id', () => {
    const db = memDb()
    const claimed = seedTopic(db, { status: 'claimed', jobId: 'job-42' })
    const other = seedTopic(db, { status: 'claimed', jobId: 'job-7' })
    markTopicUsedByJob(db, 'job-42')
    const statuses = db.prepare('SELECT id, status FROM topics ORDER BY id').all() as {
      id: number
      status: string
    }[]
    expect(statuses).toEqual([
      { id: claimed, status: 'used' },
      { id: other, status: 'claimed' },
    ])
    // manual `produce` jobs have no claimed topic: silent no-op
    expect(() => markTopicUsedByJob(db, 'job-unknown')).not.toThrow()
    db.close()
  })
})

describe('requeueTopic', () => {
  it('returns an orphaned claimed topic to the queue and unbinds its job', () => {
    const db = memDb()
    const id = seedTopic(db, { status: 'claimed', jobId: 'job-dead' })
    seedJob(db, 'job-dead', { topic: 'T', status: 'failed' })
    expect(requeueTopic(db, id)).toEqual({ ok: true })
    const row = db.prepare('SELECT status, job_id FROM topics WHERE id = ?').get(id) as {
      status: string
      job_id: string | null
    }
    expect(row).toEqual({ status: 'candidate', job_id: null })
    db.close()
  })

  it('requeues a topic whose job row is gone entirely', () => {
    const db = memDb()
    const id = seedTopic(db, { status: 'claimed', jobId: 'job-vanished' })
    expect(requeueTopic(db, id)).toEqual({ ok: true })
    expect(
      (db.prepare('SELECT status FROM topics WHERE id = ?').get(id) as { status: string }).status,
    ).toBe('candidate')
    db.close()
  })

  // A blocked job is exactly the strand requeue exists for: it is excluded
  // from the resume pass until an operator fixes the config, and until then
  // its topic is frozen out of the queue.
  it('requeues a topic held by a blocked job', () => {
    const db = memDb()
    const id = seedTopic(db, { status: 'claimed', jobId: 'job-blocked' })
    seedJob(db, 'job-blocked', { topic: 'T', status: 'blocked' })
    expect(requeueTopic(db, id)).toEqual({ ok: true })
    const row = db.prepare('SELECT status, job_id FROM topics WHERE id = ?').get(id) as {
      status: string
      job_id: string | null
    }
    expect(row).toEqual({ status: 'candidate', job_id: null })
    db.close()
  })

  // Why releasing a blocked job's topic is safe: requeue unbinds job_id, and
  // markTopicUsedByJob keys on it, so the old job later resuming to completion
  // matches nothing rather than yanking the requeued topic to 'used'.
  it('leaves the requeued topic alone when its old job later completes', () => {
    const db = memDb()
    const id = seedTopic(db, { status: 'claimed', jobId: 'job-blocked' })
    seedJob(db, 'job-blocked', { topic: 'T', status: 'blocked' })
    expect(requeueTopic(db, id)).toEqual({ ok: true })
    markTopicUsedByJob(db, 'job-blocked')
    const row = db.prepare('SELECT status, job_id FROM topics WHERE id = ?').get(id) as {
      status: string
      job_id: string | null
    }
    expect(row).toEqual({ status: 'candidate', job_id: null })
    db.close()
  })

  it('refuses while a queued or running job still holds the topic', () => {
    const db = memDb()
    for (const status of ['queued', 'running'] as const) {
      const jobId = `job-${status}`
      const id = seedTopic(db, { status: 'claimed', jobId })
      seedJob(db, jobId, { topic: 'T', status })
      expect(requeueTopic(db, id)).toEqual({
        ok: false,
        reason: 'job-active',
        jobId,
        jobStatus: status,
      })
      // the topic is untouched — the live job still owns it
      const row = db.prepare('SELECT status, job_id FROM topics WHERE id = ?').get(id) as {
        status: string
        job_id: string | null
      }
      expect(row).toEqual({ status: 'claimed', job_id: jobId })
    }
    db.close()
  })

  it('refuses an unknown id and a topic that is not claimed', () => {
    const db = memDb()
    expect(requeueTopic(db, 9999)).toEqual({ ok: false, reason: 'unknown' })
    const used = seedTopic(db, { status: 'used', jobId: 'job-old' })
    expect(requeueTopic(db, used)).toEqual({ ok: false, reason: 'not-claimed', status: 'used' })
    const candidate = seedTopic(db)
    expect(requeueTopic(db, candidate)).toEqual({
      ok: false,
      reason: 'not-claimed',
      status: 'candidate',
    })
    db.close()
  })
})

describe('listTopics', () => {
  it('maps rows to camelCase and returns newest first', () => {
    const db = memDb()
    seedTopic(db, { title: 'old', createdAt: '2026-07-19T00:00:00.000Z' })
    const newestId = seedTopic(db, {
      title: 'new',
      rawTitle: 'raw new',
      source: 'rss:example.com',
      url: 'https://example.com/new',
      dedupeHash: 'h-new',
      score: 91,
      reason: 'hooky',
      status: 'claimed',
      jobId: 'job-1',
      createdAt: '2026-07-20T00:00:00.000Z',
    })
    // An RSS item has no submission target, so target_url stays null.
    const rows = listTopics(db)
    expect(rows.map((r) => r.title)).toEqual(['new', 'old'])
    expect(rows[0]).toEqual({
      id: newestId,
      channel: 'chan-a',
      title: 'new',
      rawTitle: 'raw new',
      source: 'rss:example.com',
      url: 'https://example.com/new',
      targetUrl: null,
      bodyText: null,
      seriesKey: null,
      partIndex: null,
      partCount: null,
      truncated: false,
      dedupeHash: 'h-new',
      score: 91,
      reason: 'hooky',
      status: 'claimed',
      jobId: 'job-1',
      createdAt: '2026-07-20T00:00:00.000Z',
    })
    db.close()
  })

  it('filters by channel and status independently', () => {
    const db = memDb()
    seedTopic(db, { channel: 'chan-a', status: 'candidate' })
    seedTopic(db, { channel: 'chan-a', status: 'claimed', jobId: 'job-1' })
    seedTopic(db, { channel: 'chan-b', status: 'claimed', jobId: 'job-2' })
    expect(listTopics(db, { channel: 'chan-a' })).toHaveLength(2)
    expect(listTopics(db, { status: 'claimed' })).toHaveLength(2)
    expect(listTopics(db, { channel: 'chan-a', status: 'claimed' })).toHaveLength(1)
    db.close()
  })

  it('is unlimited by default, so existing CLI callers see every row', () => {
    const db = memDb()
    seedTopic(db)
    seedTopic(db)
    seedTopic(db)
    expect(listTopics(db)).toHaveLength(3)
    db.close()
  })

  it('honours an optional limit for callers that need one bounded (the dashboard)', () => {
    const db = memDb()
    seedTopic(db, { createdAt: '2026-07-19T00:00:00.000Z' })
    seedTopic(db, { createdAt: '2026-07-20T00:00:00.000Z' })
    seedTopic(db, { createdAt: '2026-07-21T00:00:00.000Z' })
    expect(listTopics(db, { limit: 2 }).map((t) => t.createdAt)).toEqual([
      '2026-07-21T00:00:00.000Z',
      '2026-07-20T00:00:00.000Z',
    ])
    db.close()
  })
})

describe('eligibleTopic', () => {
  it('takes only candidate, highest score first, ignoring every other status', () => {
    const db = memDb()
    seedTopic(db, { score: 70, status: 'candidate', title: 'winner' })
    seedTopic(db, { score: 95, status: 'rejected', title: 'rejected' })
    seedTopic(db, { score: 99, status: 'used', title: 'used' })
    seedTopic(db, { score: 99, status: 'claimed', title: 'claimed', jobId: 'job-1' })
    const pick = eligibleTopic(db, 'chan-a')
    expect(pick?.title).toBe('winner')
    db.close()
  })

  it('breaks score ties oldest first and returns null on an empty queue', () => {
    const db = memDb()
    seedTopic(db, { score: 80, createdAt: '2026-07-20T02:00:00.000Z', title: 'later' })
    seedTopic(db, { score: 80, createdAt: '2026-07-20T01:00:00.000Z', title: 'earlier' })
    expect(eligibleTopic(db, 'chan-a')?.title).toBe('earlier')
    expect(eligibleTopic(db, 'chan-b')).toBeNull()
    db.close()
  })
})

describe('insertTopics story columns', () => {
  it('round-trips the story fields', () => {
    const db = memDb()
    insertTopics(db, [
      {
        channel: 'aita',
        title: 'She blended the fruit (1/2)',
        rawTitle: 'AITA for not apologizing?',
        source: 'reddit:r/AmItheAsshole',
        url: 'https://reddit.com/r/AmItheAsshole/comments/abc/',
        dedupeHash: 'hash-p1',
        score: 88,
        reason: 'strong conflict',
        status: 'candidate',
        bodyText: 'One month ago I hosted a movie night.',
        seriesKey: 'series-abc',
        partIndex: 1,
        partCount: 2,
      },
    ])
    const [row] = redditCandidates(db, 'aita')
    expect(row.bodyText).toBe('One month ago I hosted a movie night.')
    expect(row.seriesKey).toBe('series-abc')
    expect(row.partIndex).toBe(1)
    expect(row.partCount).toBe(2)
  })

  it('leaves the story fields null for a topic-mode row', () => {
    const db = memDb()
    insertTopics(db, [
      {
        channel: 'space',
        title: 'Voyager 1 phones home',
        rawTitle: 'Voyager 1 phones home',
        source: 'reddit:r/space',
        url: 'https://reddit.com/r/space/comments/def/',
        dedupeHash: 'hash-plain',
        score: 90,
        reason: 'on niche',
        status: 'candidate',
      },
    ])
    const [row] = redditCandidates(db, 'space')
    expect(row.bodyText).toBeNull()
    expect(row.seriesKey).toBeNull()
    expect(row.partIndex).toBeNull()
    expect(row.partCount).toBeNull()
  })
})

describe('storyPartForJob', () => {
  it('returns the story payload for a job bound to a story topic', () => {
    const db = memDb()
    insertTopics(db, [
      {
        channel: 'aita',
        title: 'She blended the fruit (2/3)',
        rawTitle: 'AITA for not apologizing?',
        source: 'reddit:r/AmItheAsshole',
        url: 'https://reddit.com/r/AmItheAsshole/comments/abc/',
        dedupeHash: 'hash-p2',
        score: 88,
        reason: 'strong conflict',
        status: 'candidate',
        bodyText: 'Then she called my mother.',
        seriesKey: 'series-abc',
        partIndex: 2,
        partCount: 3,
      },
    ])
    const [topic] = redditCandidates(db, 'aita')
    expect(claimTopic(db, topic.id, 'job-xyz')).toBe(true)
    expect(storyPartForJob(db, 'job-xyz')).toEqual({
      bodyText: 'Then she called my mother.',
      partIndex: 2,
      partCount: 3,
      sourceUrl: 'https://reddit.com/r/AmItheAsshole/comments/abc/',
      truncated: false,
    })
  })

  it('returns null for a job with no topic row', () => {
    expect(storyPartForJob(memDb(), 'job-none')).toBeNull()
  })

  it('returns null for a job bound to a topic-mode topic', () => {
    const db = memDb()
    insertTopics(db, [
      {
        channel: 'space',
        title: 'Voyager 1 phones home',
        rawTitle: 'Voyager 1 phones home',
        source: 'reddit:r/space',
        url: 'https://reddit.com/r/space/comments/def/',
        dedupeHash: 'hash-plain',
        score: 90,
        reason: 'on niche',
        status: 'candidate',
      },
    ])
    const [topic] = redditCandidates(db, 'space')
    claimTopic(db, topic.id, 'job-plain')
    expect(storyPartForJob(db, 'job-plain')).toBeNull()
  })
})
