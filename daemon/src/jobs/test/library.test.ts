import { describe, expect, it } from 'vitest'
import type { Database } from 'better-sqlite3'
import { parseLibraryJobIds } from '../../cli.js'
import { approveLibrary, listLibrary, pendingInventory } from '../library.js'
import type { LibraryState } from '../library.js'
import { runCli } from '../../../testing/run-cli.js'
import {
  memDb,
  seedJob as seedJobRow,
  seedLibrary as seedLibraryRow,
  seedPost,
} from '../../../testing/db.js'

// Auto-numbered call shapes over the shared row builders in daemon/testing/db.ts,
// which own the SQL. The DAO only ever writes library.state, so tests still
// control every other column — the owning jobs row included — directly.
let seq = 0

function seedJob(
  db: Database,
  overrides: Partial<{ id: string; channel: string; tier: string; topic: string }> = {},
): string {
  seq += 1
  const id = overrides.id ?? `job-${seq}`
  seedJobRow(db, id, {
    channel: overrides.channel ?? 'chan-a',
    tier: overrides.tier ?? 'volume',
    topic: overrides.topic ?? `Topic ${seq}`,
    status: 'done',
  })
  return id
}

function seedLibrary(
  db: Database,
  jobId: string,
  overrides: Partial<{
    videoPath: string
    metadataJson: string
    state: LibraryState
    createdAt: string
  }> = {},
): void {
  seedLibraryRow(db, jobId, {
    videoPath: overrides.videoPath ?? `runs/${jobId}/final.mp4`,
    metadataJson: overrides.metadataJson ?? '{}',
    state: overrides.state ?? 'needs-review',
    createdAt: overrides.createdAt ?? '2026-07-20T00:00:00.000Z',
  })
}

describe('listLibrary', () => {
  it('joins jobs for channel/topic and returns newest created_at first', () => {
    const db = memDb()
    seedLibrary(db, seedJob(db, { id: 'j-old', topic: 'old topic' }), {
      createdAt: '2026-07-19T00:00:00.000Z',
    })
    seedLibrary(db, seedJob(db, { id: 'j-new', channel: 'chan-b', topic: 'deep sea trivia' }), {
      videoPath: 'runs/j-new/final.mp4',
      state: 'ready',
      createdAt: '2026-07-20T00:00:00.000Z',
    })
    const rows = listLibrary(db)
    expect(rows.map((r) => r.jobId)).toEqual(['j-new', 'j-old'])
    expect(rows[0]).toEqual({
      jobId: 'j-new',
      channel: 'chan-b',
      topic: 'deep sea trivia',
      videoPath: 'runs/j-new/final.mp4',
      state: 'ready',
      createdAt: '2026-07-20T00:00:00.000Z',
    })
    db.close()
  })

  it('filters by state and channel independently', () => {
    const db = memDb()
    seedLibrary(db, seedJob(db, { channel: 'chan-a' }), { state: 'ready' })
    seedLibrary(db, seedJob(db, { channel: 'chan-a' }), { state: 'blocked' })
    seedLibrary(db, seedJob(db, { channel: 'chan-b' }), { state: 'ready' })
    expect(listLibrary(db, { channel: 'chan-a' })).toHaveLength(2)
    expect(listLibrary(db, { state: 'ready' })).toHaveLength(2)
    expect(listLibrary(db, { channel: 'chan-a', state: 'ready' })).toHaveLength(1)
    expect(listLibrary(db, { channel: 'chan-b', state: 'blocked' })).toEqual([])
    db.close()
  })
})

describe('approveLibrary', () => {
  it('flips needs-review rows to ready and reports the changed count; other ids are skipped', () => {
    const db = memDb()
    const a = seedJob(db, { id: 'a' }) // needs-review
    seedLibrary(db, a, { state: 'needs-review' })
    const b = seedJob(db, { id: 'b' })
    seedLibrary(db, b, { state: 'ready' })
    const c = seedJob(db, { id: 'c' }) // needs-review
    seedLibrary(db, c, { state: 'needs-review' })

    // b is not needs-review and 'no-such-job' does not exist: both silently skipped
    expect(approveLibrary(db, [a, b, c, 'no-such-job'])).toBe(2)
    const states = db.prepare('SELECT job_id, state FROM library ORDER BY job_id').all() as {
      job_id: string
      state: string
    }[]
    expect(states).toEqual([
      { job_id: 'a', state: 'ready' },
      { job_id: 'b', state: 'ready' },
      { job_id: 'c', state: 'ready' },
    ])
    db.close()
  })

  it('returns 0 when no id is in needs-review state (or the batch is empty)', () => {
    const db = memDb()
    const ready = seedJob(db, { id: 'ready-job' })
    seedLibrary(db, ready, { state: 'ready' })
    const blocked = seedJob(db, { id: 'blocked-job' })
    seedLibrary(db, blocked, { state: 'blocked' })

    expect(approveLibrary(db, ['ready-job', 'blocked-job'])).toBe(0)
    expect(approveLibrary(db, [])).toBe(0)
    db.close()
  })
})

describe('pendingInventory', () => {
  it('counts a ready video with no posts at all', () => {
    const db = memDb()
    seedJobRow(db, 'j1', { channel: 'alpha' })
    seedLibrary(db, 'j1', { state: 'ready' })
    expect(pendingInventory(db, { channel: 'alpha', declared: ['youtube'] })).toBe(1)
  })

  it('stops counting once every declared platform has a post', () => {
    const db = memDb()
    seedJobRow(db, 'j1', { channel: 'alpha' })
    seedLibrary(db, 'j1', { state: 'ready' })
    seedPost(db, { jobId: 'j1', channel: 'alpha', platform: 'youtube' })
    expect(pendingInventory(db, { channel: 'alpha', declared: ['youtube', 'tiktok'] })).toBe(1)
    seedPost(db, { jobId: 'j1', channel: 'alpha', platform: 'tiktok' })
    expect(pendingInventory(db, { channel: 'alpha', declared: ['youtube', 'tiktok'] })).toBe(0)
  })

  // A post to a platform the channel does not declare must not satisfy the
  // count — otherwise a stray row would retire a video from a checklist it
  // never appeared on.
  it('ignores posts to undeclared platforms', () => {
    const db = memDb()
    seedJobRow(db, 'j1', { channel: 'alpha' })
    seedLibrary(db, 'j1', { state: 'ready' })
    seedPost(db, { jobId: 'j1', channel: 'alpha', platform: 'tiktok' })
    expect(pendingInventory(db, { channel: 'alpha', declared: ['youtube'] })).toBe(1)
  })

  it('counts needs-review videos', () => {
    const db = memDb()
    seedJobRow(db, 'j1', { channel: 'alpha' })
    seedLibrary(db, 'j1', { state: 'needs-review' })
    expect(pendingInventory(db, { channel: 'alpha', declared: ['youtube'] })).toBe(1)
  })

  it('does not count a discarded video', () => {
    const db = memDb()
    seedJobRow(db, 'j1', { channel: 'alpha' })
    seedLibrary(db, 'j1', { state: 'blocked' })
    expect(pendingInventory(db, { channel: 'alpha', declared: ['youtube'] })).toBe(0)
  })

  // Without this short-circuit the sub-select comparison reads `0 < 0` for
  // every row, nothing counts as inventory, and the channel produces
  // without bound.
  it('counts every unconsumed video when no platforms are declared', () => {
    const db = memDb()
    seedJobRow(db, 'j1', { channel: 'alpha' })
    seedJobRow(db, 'j2', { channel: 'alpha' })
    seedLibrary(db, 'j1', { state: 'ready' })
    seedLibrary(db, 'j2', { state: 'needs-review' })
    expect(pendingInventory(db, { channel: 'alpha', declared: [] })).toBe(2)
  })

  // There is deliberately no age clause. Under platform caps, ageing out
  // existed because a passed-over video could never publish; here the same
  // rule would resume production during any quiet stretch.
  it('never ages a video out, however old', () => {
    const db = memDb()
    seedJobRow(db, 'j1', { channel: 'alpha' })
    seedLibrary(db, 'j1', { state: 'ready', createdAt: '2020-01-01T00:00:00.000Z' })
    expect(pendingInventory(db, { channel: 'alpha', declared: ['youtube'] })).toBe(1)
  })

  it('scopes to one channel', () => {
    const db = memDb()
    seedJobRow(db, 'j1', { channel: 'alpha' })
    seedJobRow(db, 'j2', { channel: 'beta' })
    seedLibrary(db, 'j1', { state: 'ready' })
    seedLibrary(db, 'j2', { state: 'ready' })
    expect(pendingInventory(db, { channel: 'alpha', declared: ['youtube'] })).toBe(1)
  })
})

describe('parseLibraryJobIds (in-process)', () => {
  it('passes non-empty tokens through unchanged, in order', () => {
    expect(parseLibraryJobIds(['V1StGXR8', 'abc123_-Z'])).toEqual(['V1StGXR8', 'abc123_-Z'])
    // commander's <jobIds...> guarantees at least one token, but the helper
    // itself is total: an empty list is an empty result, not an error.
    expect(parseLibraryJobIds([])).toEqual([])
  })

  it('throws naming the first empty/whitespace-only token', () => {
    expect(() => parseLibraryJobIds([''])).toThrow(
      'invalid job id "": ids must not be empty or whitespace',
    )
    expect(() => parseLibraryJobIds(['   '])).toThrow('invalid job id "   "')
    // the FIRST offender is the one named, even when later tokens are also bad
    expect(() => parseLibraryJobIds(['j1', '', 'j2'])).toThrow('invalid job id ""')
  })
})

describe('library CLI', () => {
  it.concurrent(
    '`library --help` offers list and approve without the retired reject command',
    async () => {
      const result = await runCli(['library', '--help'])
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain('list')
      expect(result.stdout).toContain('approve')
      expect(result.stdout).not.toContain('reject')
    },
    60000,
  )
})
