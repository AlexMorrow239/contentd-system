import { describe, expect, it } from 'vitest'
import type { Database } from 'better-sqlite3'
import { parseLibraryJobIds } from '../../cli.js'
import { fakeStore } from '../../storage/fake.js'
import type { ObjectStore } from '../../storage/types.js'
import {
  approveLibrary,
  deleteRejectedObjects,
  libraryObjectKeys,
  listLibrary,
  pendingInventory,
  rejectLibrary,
} from '../library.js'
import type { LibraryState } from '../library.js'
import { runCli } from '../../testing/run-cli.js'
import { tmpDir } from '../../testing/tmp.js'
import {
  memDb,
  seedJob as seedJobRow,
  seedLibrary as seedLibraryRow,
  seedLibraryObject,
  seedPost,
} from '../../testing/db.js'

// Auto-numbered call shapes over the shared row builders in src/testing/db.ts,
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
    expect(approveLibrary(db, [a, b, c, 'no-such-job'])).toEqual({ approved: 2, reclaimed: [] })
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

    expect(approveLibrary(db, ['ready-job', 'blocked-job'])).toEqual({
      approved: 0,
      reclaimed: [],
    })
    expect(approveLibrary(db, [])).toEqual({ approved: 0, reclaimed: [] })
    db.close()
  })

  it('refuses a needs-review row whose stored object was reclaimed, and names it', () => {
    const db = memDb()
    const gone = seedJob(db, { id: 'gone-job' })
    seedLibrary(db, gone, { state: 'needs-review' })
    seedLibraryObject(db, gone, { reclaimedAt: '2026-07-20T00:00:00.000Z' })
    const held = seedJob(db, { id: 'held-job' })
    seedLibrary(db, held, { state: 'needs-review' })
    seedLibraryObject(db, held)

    // Approving a video with no bytes would put an unpublishable row into the
    // pool, where it can only be picked, fail, and be picked again.
    expect(approveLibrary(db, [gone, held])).toEqual({ approved: 1, reclaimed: ['gone-job'] })
    expect(
      db.prepare('SELECT state FROM library WHERE job_id = ?').get(gone) as { state: string },
    ).toEqual({ state: 'needs-review' })
    db.close()
  })

  it('does not report an already-ready id as a reclaimed refusal', () => {
    const db = memDb()
    const ready = seedJob(db, { id: 'ready-job' })
    seedLibrary(db, ready, { state: 'ready' })
    seedLibraryObject(db, ready, { reclaimedAt: '2026-07-20T00:00:00.000Z' })

    // It was never approvable in the first place — calling that a reclaim
    // refusal would send the operator after the wrong cause.
    expect(approveLibrary(db, [ready])).toEqual({ approved: 0, reclaimed: [] })
    db.close()
  })
})

describe('rejectLibrary', () => {
  it('flips needs-review and ready rows to blocked; unknown ids are skipped', () => {
    const db = memDb()
    const a = seedJob(db, { id: 'a' })
    seedLibrary(db, a, { state: 'needs-review' })
    const b = seedJob(db, { id: 'b' })
    seedLibrary(db, b, { state: 'ready' })

    // 'no-such-job' does not exist: skipped
    expect(rejectLibrary(db, [a, b, 'no-such-job'])).toBe(2)
    const states = db.prepare('SELECT job_id, state FROM library ORDER BY job_id').all() as {
      job_id: string
      state: string
    }[]
    expect(states).toEqual([
      { job_id: 'a', state: 'blocked' },
      { job_id: 'b', state: 'blocked' },
    ])
    expect(rejectLibrary(db, [])).toBe(0)
    db.close()
  })
})

describe('libraryObjectKeys', () => {
  it('returns the keys for the given job ids, skipping ids with no object row', () => {
    const db = memDb()
    const jobId = seedJob(db, { id: 'job-1' })
    seedLibrary(db, jobId, { state: 'ready' })
    seedLibraryObject(db, 'job-1', {
      objectKey: 'videos/example/job-1.mp4',
      bytes: 1,
      etag: 'e',
    })
    expect(libraryObjectKeys(db, ['job-1', 'job-missing'])).toEqual([
      { jobId: 'job-1', objectKey: 'videos/example/job-1.mp4' },
    ])
    db.close()
  })

  it('returns an empty array for no ids', () => {
    const db = memDb()
    expect(libraryObjectKeys(db, [])).toEqual([])
    db.close()
  })

  it('omits an already-reclaimed object', () => {
    const db = memDb()
    seedJob(db, { id: 'job-1' })
    seedLibrary(db, 'job-1')
    seedLibraryObject(db, 'job-1', { reclaimedAt: '2026-07-26T00:00:00.000Z' })

    expect(libraryObjectKeys(db, ['job-1'])).toEqual([])
  })
})

// Wraps a real store but makes `delete` throw for one chosen key, so a
// partial-failure batch can be exercised without any network/module mocking.
function storeThatFailsToDelete(store: ObjectStore, failingKey: string): ObjectStore {
  return {
    ...store,
    delete: async (key: string) => {
      if (key === failingKey) throw new Error(`boom: cannot delete ${key}`)
      await store.delete(key)
    },
  }
}

describe('deleteRejectedObjects', () => {
  function seedObjectRow(db: Database, jobId: string, objectKey: string): void {
    seedLibraryObject(db, jobId, { objectKey, bytes: 1, etag: `etag-${jobId}` })
  }

  it('is a no-op for an empty object list', async () => {
    const db = memDb()
    const store = fakeStore(tmpDir('brainrot-reject-'))
    const res = await deleteRejectedObjects({ db, objects: [], store })
    expect(res).toEqual({ deleted: [], failed: [] })
    db.close()
  })

  it('deletes every object and clears every library_objects row when all succeed', async () => {
    const db = memDb()
    const a = seedJob(db, { id: 'a' })
    const b = seedJob(db, { id: 'b' })
    seedObjectRow(db, a, 'videos/chan-a/a.mp4')
    seedObjectRow(db, b, 'videos/chan-a/b.mp4')

    const dir = tmpDir('brainrot-reject-')
    const store = fakeStore(dir)
    await store.put('videos/chan-a/a.mp4', Buffer.from('a'), 'video/mp4')
    await store.put('videos/chan-a/b.mp4', Buffer.from('b'), 'video/mp4')

    const res = await deleteRejectedObjects({
      db,
      objects: [
        { jobId: a, objectKey: 'videos/chan-a/a.mp4' },
        { jobId: b, objectKey: 'videos/chan-a/b.mp4' },
      ],
      store,
    })

    expect(res).toEqual({ deleted: [a, b], failed: [] })
    expect(db.prepare('SELECT job_id FROM library_objects').all()).toEqual([])
    db.close()
  })

  it('one key throwing lands it in failed, still processes the rest, and warns with the key', async () => {
    const db = memDb()
    const a = seedJob(db, { id: 'a' })
    const b = seedJob(db, { id: 'b' })
    const c = seedJob(db, { id: 'c' })
    seedObjectRow(db, a, 'videos/chan-a/a.mp4')
    seedObjectRow(db, b, 'videos/chan-a/b.mp4')
    seedObjectRow(db, c, 'videos/chan-a/c.mp4')

    const dir = tmpDir('brainrot-reject-')
    const inner = fakeStore(dir)
    await inner.put('videos/chan-a/a.mp4', Buffer.from('a'), 'video/mp4')
    await inner.put('videos/chan-a/b.mp4', Buffer.from('b'), 'video/mp4')
    await inner.put('videos/chan-a/c.mp4', Buffer.from('c'), 'video/mp4')
    const store = storeThatFailsToDelete(inner, 'videos/chan-a/b.mp4')

    const warnings: string[] = []
    const res = await deleteRejectedObjects({
      db,
      objects: [
        { jobId: a, objectKey: 'videos/chan-a/a.mp4' },
        { jobId: b, objectKey: 'videos/chan-a/b.mp4' },
        { jobId: c, objectKey: 'videos/chan-a/c.mp4' },
      ],
      store,
      warn: (message) => warnings.push(message),
    })

    // The other keys are still processed and their rows still cleared.
    expect(res).toEqual({ deleted: [a, c], failed: [b] })
    expect(db.prepare('SELECT job_id AS jobId FROM library_objects ORDER BY job_id').all()).toEqual(
      [{ jobId: b }],
    )
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('videos/chan-a/b.mp4')
    expect(warnings[0]).toContain(b)
    db.close()
  })

  it('leaves the library_objects row of a failed delete in place so the orphan is still discoverable', async () => {
    const db = memDb()
    const jobId = seedJob(db, { id: 'job-1' })
    seedObjectRow(db, jobId, 'videos/chan-a/job-1.mp4')

    const dir = tmpDir('brainrot-reject-')
    const inner = fakeStore(dir)
    await inner.put('videos/chan-a/job-1.mp4', Buffer.from('x'), 'video/mp4')
    const store = storeThatFailsToDelete(inner, 'videos/chan-a/job-1.mp4')

    const res = await deleteRejectedObjects({
      db,
      objects: [{ jobId, objectKey: 'videos/chan-a/job-1.mp4' }],
      store,
    })

    expect(res).toEqual({ deleted: [], failed: [jobId] })
    expect(
      db.prepare('SELECT object_key AS k FROM library_objects WHERE job_id = ?').get(jobId),
    ).toEqual({ k: 'videos/chan-a/job-1.mp4' })
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
    '`library --help` lists the list/approve/reject subcommands',
    async () => {
      const result = await runCli(['library', '--help'])
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain('list')
      expect(result.stdout).toContain('approve')
      expect(result.stdout).toContain('reject')
    },
    60000,
  )
})
