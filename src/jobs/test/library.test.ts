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
  reclaimedUnreviewedJobs,
  rejectLibrary,
} from '../library.js'
import type { LibraryState } from '../library.js'
import { runCli } from '../../testing/run-cli.js'
import { tmpDir } from '../../testing/tmp.js'
import {
  memDb,
  seedJob as seedJobRow,
  seedLibraryObject,
  seedPublish,
} from '../../testing/db.js'
import { MAX_PUBLISH_ATTEMPTS } from '../../publish/publishes.js'

// Raw-insert seed: the DAO only ever writes library.state, so tests control
// every other column — the owning jobs row included — directly.
let seq = 0

function seedJob(
  db: Database,
  overrides: Partial<{ id: string; channel: string; tier: string; topic: string }> = {},
): string {
  seq += 1
  const row = {
    id: `job-${seq}`,
    channel: 'chan-a',
    tier: 'volume',
    topic: `Topic ${seq}`,
    ...overrides,
  }
  db.prepare('INSERT INTO jobs (id, channel, tier, topic, status) VALUES (?, ?, ?, ?, ?)').run(
    row.id,
    row.channel,
    row.tier,
    row.topic,
    'done',
  )
  return row.id
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
  const row = {
    videoPath: `runs/${jobId}/final.mp4`,
    metadataJson: '{}',
    state: 'needs-review' as LibraryState,
    createdAt: '2026-07-20T00:00:00.000Z',
    ...overrides,
  }
  db.prepare(
    'INSERT INTO library (job_id, video_path, metadata_json, state, created_at) VALUES (?, ?, ?, ?, ?)',
  ).run(jobId, row.videoPath, row.metadataJson, row.state, row.createdAt)
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
    const published = seedJob(db, { id: 'published-job' })
    seedLibrary(db, published, { state: 'published' })

    expect(approveLibrary(db, ['ready-job', 'blocked-job', 'published-job'])).toEqual({
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

describe('reclaimedUnreviewedJobs', () => {
  it('names needs-review rows whose bytes were freed, and nothing else', () => {
    const db = memDb()
    const gone = seedJob(db, { id: 'gone-job', channel: 'chan-a' })
    seedLibrary(db, gone, { state: 'needs-review' })
    seedLibraryObject(db, gone, { reclaimedAt: '2026-07-20T00:00:00.000Z' })
    const held = seedJob(db, { id: 'held-job' })
    seedLibrary(db, held, { state: 'needs-review' })
    seedLibraryObject(db, held)
    // A reclaimed object on a REVIEWED row is the normal end state, not a
    // finding: the reclaim sweep only reaches it once every platform settled.
    const readyGone = seedJob(db, { id: 'ready-gone-job' })
    seedLibrary(db, readyGone, { state: 'published' })
    seedLibraryObject(db, readyGone, { reclaimedAt: '2026-07-20T00:00:00.000Z' })

    expect(reclaimedUnreviewedJobs(db)).toEqual([{ jobId: 'gone-job', channel: 'chan-a' }])
    db.close()
  })
})

describe('rejectLibrary', () => {
  it('flips needs-review, ready, and published rows to blocked; unknown ids are skipped', () => {
    const db = memDb()
    const a = seedJob(db, { id: 'a' })
    seedLibrary(db, a, { state: 'needs-review' })
    const b = seedJob(db, { id: 'b' })
    seedLibrary(db, b, { state: 'ready' })
    const c = seedJob(db, { id: 'c' })
    seedLibrary(db, c, { state: 'published' })

    // 'no-such-job' does not exist: skipped
    expect(rejectLibrary(db, [a, b, c, 'no-such-job'])).toBe(3)
    const states = db.prepare('SELECT job_id, state FROM library ORDER BY job_id').all() as {
      job_id: string
      state: string
    }[]
    expect(states).toEqual([
      { job_id: 'a', state: 'blocked' },
      { job_id: 'b', state: 'blocked' },
      { job_id: 'c', state: 'blocked' },
    ])
    expect(rejectLibrary(db, [])).toBe(0)
    db.close()
  })

  // Design spec decision 10: a video already published on one platform can
  // be pulled out of another platform's queue after the fact — 'published'
  // is no longer immutable history the way it was before cross-posting.
  it('accepts a published row and flips it to blocked', () => {
    const db = memDb()
    const jobId = seedJob(db, { id: 'job-1' })
    seedLibrary(db, jobId, { state: 'published' })

    expect(rejectLibrary(db, [jobId])).toBe(1)
    const row = db.prepare('SELECT state FROM library WHERE job_id = ?').get(jobId) as {
      state: string
    }
    expect(row.state).toBe('blocked')
    db.close()
  })
})

describe('libraryObjectKeys', () => {
  it('returns the keys for the given job ids, skipping ids with no object row', () => {
    const db = memDb()
    const jobId = seedJob(db, { id: 'job-1' })
    seedLibrary(db, jobId, { state: 'ready' })
    db.prepare(
      "INSERT INTO library_objects (job_id, object_key, bytes, etag) VALUES ('job-1','videos/example/job-1.mp4',1,'e')",
    ).run()
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
    db.prepare(
      'INSERT INTO library_objects (job_id, object_key, bytes, etag) VALUES (?, ?, 1, ?)',
    ).run(jobId, objectKey, `etag-${jobId}`)
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
  const CUTOFF = '2026-07-25T00:00:00.000Z'
  const FRESH = '2026-07-26T00:00:00.000Z'
  const AGED = '2026-07-20T00:00:00.000Z'
  // Inside an AGED video's grace window: after it was produced, at or before
  // the horizon. That is what contention has to be (publish/settled.ts).
  const OUTRANKED_AT = '2026-07-23T00:00:00.000Z'

  function seedVideo(db: Database, jobId: string, state: LibraryState, createdAt: string): void {
    seedJobRow(db, jobId, { channel: 'chan-a' })
    seedLibrary(db, jobId, { state, createdAt })
  }

  it('counts a ready video with no publishes rows', () => {
    const db = memDb()
    seedVideo(db, 'job-1', 'ready', FRESH)
    expect(
      pendingInventory(db, { channel: 'chan-a', declared: ['youtube'], createdAfter: CUTOFF }),
    ).toBe(1)
  })

  it('counts a needs-review video', () => {
    const db = memDb()
    seedVideo(db, 'job-1', 'needs-review', FRESH)
    expect(
      pendingInventory(db, { channel: 'chan-a', declared: ['youtube'], createdAfter: CUTOFF }),
    ).toBe(1)
  })

  it('does not count a blocked video', () => {
    const db = memDb()
    seedVideo(db, 'job-1', 'blocked', FRESH)
    expect(
      pendingInventory(db, { channel: 'chan-a', declared: ['youtube'], createdAfter: CUTOFF }),
    ).toBe(0)
  })

  it('counts a video published on one of two declared platforms', () => {
    const db = memDb()
    seedVideo(db, 'job-1', 'published', FRESH)
    seedPublish(db, 'job-1', { platform: 'instagram', channel: 'chan-a', status: 'done', seq: 1 })
    expect(
      pendingInventory(db, {
        channel: 'chan-a',
        declared: ['youtube', 'instagram'],
        createdAfter: CUTOFF,
      }),
    ).toBe(1)
  })

  it('does not count a video published on every declared platform', () => {
    const db = memDb()
    seedVideo(db, 'job-1', 'published', FRESH)
    seedPublish(db, 'job-1', { platform: 'youtube', channel: 'chan-a', status: 'done', seq: 1 })
    expect(
      pendingInventory(db, { channel: 'chan-a', declared: ['youtube'], createdAfter: CUTOFF }),
    ).toBe(0)
  })

  it('does not count an attempt-capped video — nothing can ever drain it', () => {
    const db = memDb()
    seedVideo(db, 'job-1', 'ready', FRESH)
    for (let i = 0; i < MAX_PUBLISH_ATTEMPTS; i++) {
      seedPublish(db, 'job-1', {
        platform: 'youtube',
        channel: 'chan-a',
        status: 'failed',
        errorKind: 'rejected',
        seq: i + 1,
      })
    }
    expect(
      pendingInventory(db, { channel: 'chan-a', declared: ['youtube'], createdAfter: CUTOFF }),
    ).toBe(0)
  })

  it('does not count a passed-over video once it ages out behind a newer one', () => {
    const db = memDb()
    seedVideo(db, 'job-1', 'published', AGED)
    seedPublish(db, 'job-1', { platform: 'instagram', channel: 'chan-a', status: 'done', seq: 1 })
    // The contention ageing out requires: another job really did take a slot
    // while job-1 was waiting — a done row after job-1 was produced and no
    // later than the horizon. Seeded with NO library row of its own, so the
    // count below is job-1 alone and 0 proves job-1 actually left inventory.
    seedJobRow(db, 'job-2', { channel: 'chan-a' })
    seedPublish(db, 'job-2', {
      platform: 'instagram',
      channel: 'chan-a',
      status: 'done',
      seq: 2,
      createdAt: OUTRANKED_AT,
    })
    expect(
      pendingInventory(db, {
        channel: 'chan-a',
        declared: ['youtube', 'instagram'],
        createdAfter: CUTOFF,
      }),
    ).toBe(0)
  })

  it('still counts an old video whose only later publish landed past the horizon', () => {
    // The recovering outage: one publish after the window closed must not age
    // out the backlog that was stranded behind it. Counting it here is half of
    // the lockstep — channelVideoCandidates must keep offering it too.
    const db = memDb()
    seedVideo(db, 'job-1', 'ready', AGED)
    seedJobRow(db, 'job-2', { channel: 'chan-a' })
    seedPublish(db, 'job-2', {
      platform: 'instagram',
      channel: 'chan-a',
      status: 'done',
      seq: 1,
      createdAt: '2026-07-27T00:00:00.000Z',
    })
    expect(
      pendingInventory(db, {
        channel: 'chan-a',
        declared: ['youtube', 'instagram'],
        createdAfter: CUTOFF,
      }),
    ).toBe(1)
  })

  it('still counts old videos when the channel has published nothing at all', () => {
    // A publish outage longer than backlog_days. Nothing outranked these, so
    // they are still publishable — and inventory that disappeared here while
    // the candidate scan kept offering them would let production run away.
    const db = memDb()
    seedVideo(db, 'job-1', 'ready', AGED)
    seedVideo(db, 'job-2', 'ready', AGED)
    expect(
      pendingInventory(db, {
        channel: 'chan-a',
        declared: ['youtube', 'instagram'],
        createdAfter: CUTOFF,
      }),
    ).toBe(2)
  })

  it('ignores other channels', () => {
    const db = memDb()
    seedJobRow(db, 'job-b', { channel: 'chan-b' })
    seedLibrary(db, 'job-b', { state: 'ready', createdAt: FRESH })
    expect(
      pendingInventory(db, { channel: 'chan-a', declared: ['youtube'], createdAfter: CUTOFF }),
    ).toBe(0)
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
