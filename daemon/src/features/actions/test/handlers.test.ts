import type { Database } from 'better-sqlite3'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  countJobs,
  getJobDetail,
  listJobs,
} from '../../../../../dashboard/lib/server/queries/jobs.js'
import { channelToml, testChannel, writeChannelsDir } from '../../../../testing/channel.js'
import {
  memDb,
  seedCost,
  seedJob,
  seedLibrary,
  seedPost,
  seedTopic,
} from '../../../../testing/db.js'
import { createTestTime } from '../../../../testing/time.js'
import { tmpDir } from '../../../../testing/tmp.js'
import { LeaseLostError, acquireManagedLease } from '../../../infra/coordination/lease.js'
import { ContentdError } from '../../../shared/errors.js'
import { channelDaySpentMicros } from '../../billing/costs.js'
import { markPosted, postedPlatforms } from '../../posting/posts.js'
import { beginAttempt } from '../../production/jobs/execution.js'
import { claimJobForResume } from '../../production/jobs/resume.js'
import { planTick } from '../../production/plan-tick.js'
import { ACTION_KINDS } from '../catalog.js'
import { type ActionContext } from '../handler-contract.js'
import { ACTION_HANDLERS, runAction } from '../handlers.js'

function ctx(db: Database): ActionContext {
  return {
    db,
    time: createTestTime(new Date('2026-08-01T10:00:00Z')),
    channelsDir: '/nonexistent/channels',
    runsRoot: '/nonexistent/runs',
    setNotice: () => {},
  }
}

describe('action handlers', () => {
  it.each([
    ['jobs.delete', { jobId: 'j1' }],
    ['topics.reject', { ids: ['1'] }],
    ['topics.requeue', { id: '1' }],
    ['library.approve', { jobIds: ['j1'] }],
    ['post.mark', { jobId: 'j1', platform: 'youtube' }],
    ['post.unmark', { jobId: 'j1', platform: 'youtube' }],
  ] as const)('%s fences its domain mutation inside a transaction', async (kind, args) => {
    const db = memDb()
    seedJob(db, 'j1')
    seedLibrary(db, 'j1', { state: 'needs-review' })
    seedTopic(db, { status: kind === 'topics.requeue' ? 'claimed' : 'candidate', jobId: null })
    if (kind === 'post.unmark') markPosted(db, { jobId: 'j1', platform: 'youtube' })
    const snapshot = () =>
      ['jobs', 'topics', 'library', 'posts'].map((table) =>
        db.prepare(`SELECT * FROM ${table}`).all(),
      )
    const before = snapshot()
    const lease = acquireManagedLease(db, 'daemon')!
    const lost = new LeaseLostError('daemon')
    const guarded = vi.fn(() => {
      // The dispatch check succeeds. Simulate loss when the write lock is
      // acquired; the guard must reject before any domain row can change.
      if (db.inTransaction) throw lost
    })
    try {
      await expect(
        runAction(
          { ...ctx(db), time: lease.time, daemonLease: { ...lease, assertOwned: guarded } },
          kind,
          args,
        ),
      ).rejects.toBe(lost)
      expect(guarded).toHaveBeenCalledTimes(2)
      expect(db.inTransaction).toBe(false)
      expect(snapshot()).toEqual(before)
    } finally {
      lease.release()
    }
  })

  it('deletes a job from the dashboard without erasing spend or retrying its topic', async () => {
    const time = createTestTime(new Date('2026-08-01T10:00:00Z'))
    const db = memDb(time)
    seedJob(db, 'j1', { status: 'blocked' })
    seedLibrary(db, 'j1')
    seedPost(db, { jobId: 'j1' })
    seedCost(db, 'j1', { usdMicros: 1234 })
    seedTopic(db, { status: 'claimed', jobId: 'j1' })
    const context = { ...ctx(db), time }
    expect(await runAction(context, 'jobs.delete', { jobId: 'j1' })).toEqual({
      jobId: 'j1',
      deleted: true,
    })
    expect(listJobs(db)).toEqual([])
    expect(countJobs(db)).toBe(0)
    expect(getJobDetail(db, 'j1')).toBeNull()
    expect(db.prepare('SELECT * FROM library').all()).toEqual([])
    expect(db.prepare('SELECT * FROM posts').all()).toEqual([])
    expect(db.prepare('SELECT status, job_id FROM topics').get()).toEqual({
      status: 'rejected',
      job_id: null,
    })
    expect(channelDaySpentMicros(db, 'chan-a', '2026-08-01')).toBe(1234)
    expect(planTick(db, [testChannel({ name: 'chan-a' })], time).kind).toBe('noop')
    expect(claimJobForResume(db, 'j1', true)).toBe(false)
    const lease = acquireManagedLease(db, 'produce', undefined, { time })!
    try {
      expect(() => beginAttempt(db, 'j1', lease)).toThrow(/deleted|not found/)
    } finally {
      lease.release()
    }
    expect(await runAction(context, 'jobs.delete', { jobId: 'j1' })).toEqual({
      jobId: 'j1',
      deleted: false,
    })
  })

  it('refuses to delete a running job without changing its records', async () => {
    const db = memDb()
    seedJob(db, 'running', { status: 'running' })
    seedLibrary(db, 'running')
    await expect(runAction(ctx(db), 'jobs.delete', { jobId: 'running' })).rejects.toMatchObject({
      kind: 'conflict',
    })
    expect(getJobDetail(db, 'running')).not.toBeNull()
    expect(db.prepare('SELECT * FROM library').all()).toHaveLength(1)
  })

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
    await expect(runAction(ctx(db), 'topics.reject', { ids: [] })).rejects.toThrow(ContentdError)
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
    expect(caught).toBeInstanceOf(ContentdError)
    const err = caught as ContentdError
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
      {
        db,
        time: createTestTime(new Date('2040-01-01T00:00:00Z')),
        channelsDir: '/ch',
        runsRoot: '/runs',
        setNotice: () => {},
      },
      {},
      { produceNextTick: tick },
    )
    expect(tick).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        channelsDir: '/ch',
        runsRoot: '/runs',
        time: expect.objectContaining({ now: expect.any(Function) }),
      }),
    )
    expect(result).toEqual({ action: 'produced', jobId: 'j1', status: 'ready' })
  })

  it('produce.next records a lease-held noop as a successful, truthful result', async () => {
    const db = memDb()
    const tick = vi.fn().mockResolvedValue({ action: 'noop', reason: 'lease-held' })
    const result = await ACTION_HANDLERS['produce.next'](
      {
        db,
        time: createTestTime(new Date('2040-01-01T00:00:00Z')),
        channelsDir: '/ch',
        runsRoot: '/runs',
        setNotice: () => {},
      },
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
      {
        db,
        time: createTestTime(new Date('2040-01-01T00:00:00Z')),
        channelsDir: dir,
        runsRoot: '/runs',
        setNotice: () => {},
      },
      {},
      { scoutAll: scout },
    )
    // force:true is the whole point — SCOUT_RECHECK_MS is 20 minutes, so an
    // unforced "scout now" button would silently no-op most times it is clicked.
    expect(scout).toHaveBeenCalledWith(
      db,
      expect.arrayContaining([expect.objectContaining({ name: 'a' })]),
      expect.objectContaining({
        force: true,
        time: expect.objectContaining({ now: expect.any(Function) }),
      }),
    )
    expect(result).toEqual({ channels: [{ channel: 'a', inserted: 2 }] })
  })

  it('scout.run reports a broken channels directory as a noop, not a failure', async () => {
    const db = memDb()
    const dir = tmpDir('scout-action-broken')
    writeFileSync(join(dir, 'bad.toml'), 'name = ')
    const scout = vi.fn()
    const result = await ACTION_HANDLERS['scout.run'](
      {
        db,
        time: createTestTime(new Date('2040-01-01T00:00:00Z')),
        channelsDir: dir,
        runsRoot: '/runs',
        setNotice: () => {},
      },
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
      {
        db,
        time: createTestTime(new Date('2040-01-01T00:00:00Z')),
        channelsDir: '/ch',
        runsRoot: '/runs',
        setNotice: () => {},
      },
      { jobId: 'j1' },
      { resumeJob: resume },
    )
    expect(resume).toHaveBeenCalledWith(
      db,
      'j1',
      expect.objectContaining({
        runsRoot: '/runs',
        channelsDir: '/ch',
        time: expect.objectContaining({ now: expect.any(Function) }),
      }),
    )
    expect(result).toEqual({ jobId: 'j1', status: 'ready' })
  })

  it('jobs.resume propagates a refusal', async () => {
    const db = memDb()
    const resume = vi.fn().mockRejectedValue(new Error('job j9 is already done'))
    await expect(
      ACTION_HANDLERS['jobs.resume'](
        {
          db,
          time: createTestTime(new Date('2040-01-01T00:00:00Z')),
          channelsDir: '/ch',
          runsRoot: '/runs',
          setNotice: () => {},
        },
        { jobId: 'j9' },
        { resumeJob: resume },
      ),
    ).rejects.toThrow('already done')
  })

  it('jobs.produce resolves a channel NAME to its config and runs the pipeline', async () => {
    const db = memDb()
    const dir = writeChannelsDir(
      { 'alpha.toml': channelToml({ name: 'alpha' }) },
      tmpDir('produce-action'),
    )
    // Echoes back the real jobId createJob generated, exactly as the real
    // runJob does — it never invents a different id than the one it was
    // given. A hardcoded literal here (e.g. 'j1') would make the notice
    // assertion below depend on nanoid() happening to produce that literal,
    // which it practically never does.
    const run = vi
      .fn()
      .mockImplementation((_db, _channel, id: string) =>
        Promise.resolve({ jobId: id, status: 'ready' }),
      )
    const notices: string[] = []
    const result = await ACTION_HANDLERS['jobs.produce'](
      {
        db,
        time: createTestTime(new Date('2040-01-01T00:00:00Z')),
        channelsDir: dir,
        runsRoot: '/runs',
        setNotice: (t) => notices.push(t),
      },
      { channel: 'alpha', topic: 'why the moon is loud' },
      { runJob: run },
    )
    expect(result).toMatchObject({ status: 'ready' })
    const jobId = (result as { jobId: string }).jobId
    expect(jobId.length).toBeGreaterThan(0)
    // The job id is published the moment it exists: a SIGKILL mid-render leaves
    // a failed action row, and this notice is the only thing linking it to a
    // job that is still resumable.
    expect(notices.some((n) => n.includes(jobId))).toBe(true)
  })

  it('jobs.produce rejects an unknown channel name without creating a job', async () => {
    const db = memDb()
    const dir = writeChannelsDir(
      { 'alpha.toml': channelToml({ name: 'alpha' }) },
      tmpDir('produce-action-unknown'),
    )
    await expect(
      ACTION_HANDLERS['jobs.produce'](
        {
          db,
          time: createTestTime(new Date('2040-01-01T00:00:00Z')),
          channelsDir: dir,
          runsRoot: '/runs',
          setNotice: () => {},
        },
        { channel: 'beta', topic: 't' },
        {},
      ),
    ).rejects.toThrow(/beta/)
    expect((db.prepare('SELECT COUNT(*) AS n FROM jobs').get() as { n: number }).n).toBe(0)
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
    expect(postedPlatforms(db, ['j1']).get('j1')?.size).toBe(1)
  })

  // The handler must resolve the channel itself: the dashboard form has a job
  // id, and denormalizing the wrong channel onto the row would misfile the
  // video in every channel-scoped read.
  it('post.mark resolves the channel from the job', async () => {
    const db = memDb()
    seedJob(db, 'j1', { channel: 'beta' })
    seedLibrary(db, 'j1', { state: 'ready' })
    await runAction(ctx(db), 'post.mark', { jobId: 'j1', platform: 'youtube' })
    const rows = db.prepare('SELECT channel FROM posts WHERE job_id = ?').all('j1') as {
      channel: string
    }[]
    expect(rows[0]?.channel).toBe('beta')
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
})
