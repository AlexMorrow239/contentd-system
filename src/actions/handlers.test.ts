import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { Database } from 'better-sqlite3'
import { BrainrotError } from '../errors.js'
import { channelToml, writeChannelsDir } from '../testing/channel.js'
import { memDb, seedJob, seedLibrary, seedLibraryObject, seedTopic } from '../testing/db.js'
import { postsForJob } from '../posts/posts.js'
import { fakeStore } from '../storage/fake.js'
import { stubStorageEnv } from '../testing/storage.js'
import { tmpDir } from '../testing/tmp.js'
import { ACTION_KINDS } from './catalog.js'
import { ACTION_HANDLERS, runAction, type ActionContext } from './handlers.js'

function ctx(db: Database): ActionContext {
  return {
    db,
    now: new Date('2026-08-01T10:00:00Z'),
    channelsDir: '/nonexistent/channels',
    runsRoot: '/nonexistent/runs',
    setNotice: () => {},
  }
}

describe('action handlers', () => {
  it('has exactly one handler per catalog entry', () => {
    // `ACTION_HANDLERS`'s mapped type already makes a missing handler a
    // compile error — this is cheap insurance against a future `as any` cast
    // or object-spread escaping that guarantee at runtime, not what actually
    // prevents the drift.
    expect(Object.keys(ACTION_HANDLERS).sort()).toEqual([...ACTION_KINDS].sort())
  })

  it('rejects candidate topics and reports how many changed', async () => {
    const db = memDb()
    const a = seedTopic(db, { title: 'one' })
    const b = seedTopic(db, { title: 'two', status: 'used' })
    const result = await runAction(ctx(db), 'topics.reject', { ids: [String(a), String(b)] })
    expect(result).toEqual({ rejected: 1, requested: 2 })
  })

  it('validates args before touching the database', async () => {
    const db = memDb()
    await expect(runAction(ctx(db), 'topics.reject', { ids: [] })).rejects.toThrow(BrainrotError)
  })

  it('requeues a claimed topic', async () => {
    const db = memDb()
    const id = seedTopic(db, { status: 'claimed', jobId: null })
    expect(await runAction(ctx(db), 'topics.requeue', { id: String(id) })).toEqual({ ok: true })
  })

  it('surfaces a refused requeue as a failure, not a silent success', async () => {
    // A candidate topic is not claimed; the CLI reports this and exits 1, so
    // the action must fail rather than record ok.
    const db = memDb()
    const id = seedTopic(db, { status: 'candidate' })
    await expect(runAction(ctx(db), 'topics.requeue', { id: String(id) })).rejects.toThrow(
      /not-claimed/,
    )
  })

  it('surfaces a job-active requeue refusal as a conflict, with the job detail attached', async () => {
    // 'job-active' means someone else (a live job) still holds the topic —
    // errors.ts defines that as 'conflict', not 'refused'.
    const db = memDb()
    seedJob(db, 'j1', { status: 'running' })
    const id = seedTopic(db, { status: 'claimed', jobId: 'j1' })
    let caught: unknown
    try {
      await runAction(ctx(db), 'topics.requeue', { id: String(id) })
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(BrainrotError)
    const err = caught as BrainrotError
    expect(err.kind).toBe('conflict')
    expect(err.context).toEqual({ jobId: 'j1', jobStatus: 'running' })
  })

  it('approves a clean needs-review library row', async () => {
    const db = memDb()
    seedJob(db, 'j1')
    seedLibrary(db, 'j1', { state: 'needs-review' })
    expect(await runAction(ctx(db), 'library.approve', { jobIds: 'j1' })).toEqual({
      approved: 1,
      requested: 1,
      reclaimed: [],
    })
  })

  it('refuses to approve a reclaimed row and reports it, not as an error', async () => {
    const db = memDb()
    seedJob(db, 'j1')
    seedLibrary(db, 'j1', { state: 'needs-review' })
    seedLibraryObject(db, 'j1', { reclaimedAt: '2026-07-30T00:00:00Z' })
    expect(await runAction(ctx(db), 'library.approve', { jobIds: 'j1' })).toEqual({
      approved: 0,
      requested: 1,
      reclaimed: ['j1'],
    })
  })

  it('returns the digest text', async () => {
    const db = memDb()
    const result = (await runAction(ctx(db), 'digest.run', {})) as { text: string }
    expect(typeof result.text).toBe('string')
    expect(result.text.length).toBeGreaterThan(0)
  })

  it('produce.next runs one produce tick and records its result verbatim', async () => {
    const db = memDb()
    const tick = vi.fn().mockResolvedValue({ action: 'produced', jobId: 'j1', status: 'ready' })
    const result = await ACTION_HANDLERS['produce.next'](
      { db, now: new Date(), channelsDir: '/ch', runsRoot: '/runs', setNotice: () => {} },
      {},
      { produceNextTick: tick },
    )
    expect(tick).toHaveBeenCalledWith(db, { channelsDir: '/ch', runsRoot: '/runs' })
    expect(result).toEqual({ action: 'produced', jobId: 'j1', status: 'ready' })
  })

  it('produce.next records a lease-held noop as a successful, truthful result', async () => {
    const db = memDb()
    const tick = vi.fn().mockResolvedValue({ action: 'noop', reason: 'lease-held' })
    const result = await ACTION_HANDLERS['produce.next'](
      { db, now: new Date(), channelsDir: '/ch', runsRoot: '/runs', setNotice: () => {} },
      {},
      { produceNextTick: tick },
    )
    // NOT a throw: the tick ran and declined because a render is in flight. This
    // is exactly what the CLI does (exit 0, benign noop).
    expect(result).toEqual({ action: 'noop', reason: 'lease-held' })
  })

  it('scout.run forces past the recheck cooldown', async () => {
    const db = memDb()
    const scout = vi.fn().mockResolvedValue([{ channel: 'a', inserted: 2 }])
    const dir = writeChannelsDir({ 'a.toml': channelToml({ name: 'a' }) }, tmpDir('scout-action'))
    const result = await ACTION_HANDLERS['scout.run'](
      { db, now: new Date(), channelsDir: dir, runsRoot: '/runs', setNotice: () => {} },
      {},
      { scoutAll: scout },
    )
    // force:true is the whole point — SCOUT_RECHECK_MS is 20 minutes, so an
    // unforced "scout now" button would silently no-op most times it is clicked.
    expect(scout).toHaveBeenCalledWith(
      db,
      expect.arrayContaining([expect.objectContaining({ name: 'a' })]),
      { force: true },
    )
    expect(result).toEqual({ channels: [{ channel: 'a', inserted: 2 }] })
  })

  it('scout.run reports a broken channels directory as a noop, not a failure', async () => {
    const db = memDb()
    const dir = tmpDir('scout-action-broken')
    writeFileSync(join(dir, 'bad.toml'), 'name = ')
    const scout = vi.fn()
    const result = await ACTION_HANDLERS['scout.run'](
      { db, now: new Date(), channelsDir: dir, runsRoot: '/runs', setNotice: () => {} },
      {},
      { scoutAll: scout },
    )
    // Every sibling hitting this same tryLoadChannelsDir condition records
    // `done` with the reason visible: digest.run folds loaded.error into its
    // result, produce.next passes through the tick's own
    // {action:'noop',reason:'config-error'}, and the CLI's own `scout` exits 0.
    // A lone `failed` here would be an inconsistency with no reason behind it.
    expect(result).toEqual({
      action: 'noop',
      reason: 'config-error',
      error: expect.stringContaining('bad.toml'),
    })
    expect(scout).not.toHaveBeenCalled()
  })

  it('jobs.resume resumes without force and returns the job result', async () => {
    const db = memDb()
    const resume = vi.fn().mockResolvedValue({ jobId: 'j1', status: 'ready' })
    const result = await ACTION_HANDLERS['jobs.resume'](
      { db, now: new Date(), channelsDir: '/ch', runsRoot: '/runs', setNotice: () => {} },
      { jobId: 'j1' },
      { resumeJob: resume },
    )
    expect(resume).toHaveBeenCalledWith(db, 'j1', { runsRoot: '/runs', channelsDir: '/ch' })
    expect(result).toEqual({ jobId: 'j1', status: 'ready' })
  })

  it('jobs.resume propagates a refusal', async () => {
    const db = memDb()
    const resume = vi.fn().mockRejectedValue(new Error('job j9 is already done'))
    await expect(
      ACTION_HANDLERS['jobs.resume'](
        { db, now: new Date(), channelsDir: '/ch', runsRoot: '/runs', setNotice: () => {} },
        { jobId: 'j9' },
        { resumeJob: resume },
      ),
    ).rejects.toThrow('already done')
  })

  it('post.mark records the post', async () => {
    const db = memDb()
    seedJob(db, 'j1', { channel: 'alpha' })
    seedLibrary(db, 'j1', { state: 'ready' })
    const result = await runAction(ctx(db), 'post.mark', {
      jobId: 'j1',
      platform: 'youtube',
      url: 'https://y/1',
    })
    expect(result).toEqual({ jobId: 'j1', platform: 'youtube', posted: true })
    expect(postsForJob(db, 'j1')).toHaveLength(1)
  })

  // The handler must resolve the channel itself: the dashboard form has a job
  // id, and denormalizing the wrong channel onto the row would misfile the
  // video in every channel-scoped read.
  it('post.mark resolves the channel from the job', async () => {
    const db = memDb()
    seedJob(db, 'j1', { channel: 'beta' })
    seedLibrary(db, 'j1', { state: 'ready' })
    await runAction(ctx(db), 'post.mark', { jobId: 'j1', platform: 'youtube' })
    expect(postsForJob(db, 'j1')[0]?.channel).toBe('beta')
  })

  it('post.mark throws for an unknown job', async () => {
    await expect(
      runAction(ctx(memDb()), 'post.mark', { jobId: 'nope', platform: 'youtube' }),
    ).rejects.toThrow(/nope/)
  })

  it('post.unmark reports when there was nothing to unmark', async () => {
    const db = memDb()
    seedJob(db, 'j1', { channel: 'alpha' })
    const result = await runAction(ctx(db), 'post.unmark', { jobId: 'j1', platform: 'youtube' })
    expect(result).toEqual({ jobId: 'j1', platform: 'youtube', removed: false })
  })

  it('library.reject discards and reports the count', async () => {
    const db = memDb()
    seedJob(db, 'j1', { channel: 'alpha' })
    seedLibrary(db, 'j1', { state: 'ready' })
    const result = await runAction(ctx(db), 'library.reject', { jobIds: ['j1'] })
    expect(result).toEqual({ rejected: 1, requested: 1, objectsDeleted: 0, objectsFailed: 0 })
  })

  it('library.reject deletes the stored object and drops the library_objects row', async () => {
    stubStorageEnv()
    const db = memDb()
    seedJob(db, 'j1', { channel: 'alpha' })
    seedLibrary(db, 'j1', { state: 'ready' })
    seedLibraryObject(db, 'j1', { objectKey: 'videos/j1.mp4' })
    const store = fakeStore(tmpDir('brainrot-handlers-reject-'))
    const deleteSpy = vi.spyOn(store, 'delete')
    // Seed the object into the fake store so a real delete has something to
    // remove — proves the handler actually calls store.delete with the right
    // key, not just that it returns a plausible-looking result.
    await store.put('videos/j1.mp4', Buffer.from('x'), 'video/mp4')

    const result = await ACTION_HANDLERS['library.reject'](
      ctx(db),
      { jobIds: ['j1'] },
      { storeFromEnv: () => store },
    )

    expect(deleteSpy).toHaveBeenCalledWith('videos/j1.mp4')
    expect(result).toEqual({ rejected: 1, requested: 1, objectsDeleted: 1, objectsFailed: 0 })
    expect(db.prepare('SELECT * FROM library_objects WHERE job_id = ?').get('j1')).toBeUndefined()
    expect(
      (db.prepare('SELECT state FROM library WHERE job_id = ?').get('j1') as { state: string })
        .state,
    ).toBe('blocked')
  })

  it('library.reject does not fail the action when the store delete throws', async () => {
    stubStorageEnv()
    const db = memDb()
    seedJob(db, 'j1', { channel: 'alpha' })
    seedLibrary(db, 'j1', { state: 'ready' })
    seedLibraryObject(db, 'j1', { objectKey: 'videos/j1.mp4' })
    const failingStore = {
      ...fakeStore(tmpDir('brainrot-handlers-reject-fail-')),
      delete: vi.fn().mockRejectedValue(new Error('network unreachable')),
    }

    const result = await ACTION_HANDLERS['library.reject'](
      ctx(db),
      { jobIds: ['j1'] },
      { storeFromEnv: () => failingStore },
    )

    expect(result).toEqual({ rejected: 1, requested: 1, objectsDeleted: 0, objectsFailed: 1 })
    // The state change stands even though the delete failed — the row is
    // left in place so the next sweep can retry the delete.
    expect(
      (db.prepare('SELECT state FROM library WHERE job_id = ?').get('j1') as { state: string })
        .state,
    ).toBe('blocked')
    expect(db.prepare('SELECT * FROM library_objects WHERE job_id = ?').get('j1')).toBeDefined()
  })

  it('library.reject treats unconfigured object storage as nothing to delete', async () => {
    vi.stubEnv('BRAINROT_S3_ENDPOINT', '')
    vi.stubEnv('BRAINROT_S3_BUCKET', '')
    vi.stubEnv('BRAINROT_S3_ACCESS_KEY_ID', '')
    vi.stubEnv('BRAINROT_S3_SECRET_ACCESS_KEY', '')
    const db = memDb()
    seedJob(db, 'j1', { channel: 'alpha' })
    seedLibrary(db, 'j1', { state: 'ready' })
    seedLibraryObject(db, 'j1', { objectKey: 'videos/j1.mp4' })

    const result = await runAction(ctx(db), 'library.reject', { jobIds: ['j1'] })

    expect(result).toMatchObject({ rejected: 1, requested: 1, objectsDeleted: 0 })
    expect(
      (db.prepare('SELECT state FROM library WHERE job_id = ?').get('j1') as { state: string })
        .state,
    ).toBe('blocked')
  })
})
