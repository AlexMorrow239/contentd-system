import {
  chmodSync,
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { channelToml, writeChannelsDir } from '../../../testing/channel.js'
import { memDb, seedJob, seedLibrary, seedPost } from '../../../testing/db.js'
import { createTestTime } from '../../../testing/time.js'
import { testRoot } from '../../../testing/tmp.js'
import { cleanupUnit } from '../cleanup-unit.js'
import { requireLease } from '../lease.js'
import { markPosted, unmarkPosted } from '../../posts/posts.js'
import { getJobDetail } from '../../../../dashboard/lib/server/queries/jobs.js'
import { streamVideo } from '../../../../dashboard/lib/server/stream-video.js'

function fixture(platforms = ['youtube', 'tiktok']) {
  const paths = testRoot()
  const time = createTestTime(new Date('2026-09-29T12:00:00.000Z'))
  const db = memDb(time)
  const configure = (declared: string[]) =>
    writeChannelsDir(
      { 'alpha.toml': channelToml({ name: 'alpha', platforms: declared }) },
      paths.channelsDir,
    )
  configure(platforms)
  const makeUnit = (daemonLease?: ReturnType<typeof requireLease>) =>
    cleanupUnit(db, { ...paths, time, daemonLease })
  const video = (
    id = 'job-1',
    opts: {
      age?: number
      posted?: string[]
      status?: string
      channel?: string
      legacy?: boolean
    } = {},
  ) => {
    const channel = opts.channel ?? 'alpha'
    seedJob(db, id, { channel, status: opts.status ?? 'done' })
    const videoPath = join(
      paths.runsRoot,
      id,
      ...(opts.legacy ? [] : ['attempts', 'attempt-1']),
      'assemble',
      'final.mp4',
    )
    mkdirSync(dirname(videoPath), { recursive: true })
    writeFileSync(videoPath, 'finished MP4 fixture')
    seedLibrary(db, id, { videoPath, metadataJson: '{"title":"keep me"}' })
    for (const platform of opts.posted ?? platforms) {
      seedPost(db, {
        jobId: id,
        channel,
        platform,
        url: `https://example.com/${id}/${platform}`,
        postedAt: new Date(time.now().getTime() - (opts.age ?? 86_400_000)).toISOString(),
      })
    }
    return videoPath
  }
  return { ...paths, db, time, configure, makeUnit, video }
}

describe('cleanupUnit', () => {
  it('deletes only the library MP4 at 24 hours and preserves records and other artifacts', async () => {
    const f = fixture()
    const expired = f.video()
    const recent = f.video('recent', { age: 86_399_999 })
    const intermediate = join(dirname(expired), 'background.mp4')
    const metadata = join(dirname(expired), 'metadata.json')
    writeFileSync(intermediate, 'keep intermediate')
    writeFileSync(metadata, '{}')
    const library = f.db.prepare('SELECT * FROM library').all()
    const posts = f.db.prepare('SELECT * FROM posts').all()

    const result = await f.makeUnit()()

    expect(existsSync(expired)).toBe(false)
    expect(existsSync(recent)).toBe(true)
    expect(existsSync(intermediate)).toBe(true)
    expect(existsSync(metadata)).toBe(true)
    expect(f.db.prepare('SELECT * FROM library').all()).toEqual(library)
    expect(f.db.prepare('SELECT * FROM posts').all()).toEqual(posts)
    expect(result.line).toMatchObject({
      action: 'cleanup',
      deleted: [{ jobId: 'job-1', videoPath: expired }],
      errors: [],
    })
    expect(getJobDetail(f.db, 'job-1')?.job.video?.bytes).toBe('missing')
    expect(
      streamVideo(new Request('http://localhost/video'), f.db, f.runsRoot, 'job-1').status,
    ).toBe(404)
  })

  it('waits for the latest required post and ignores newer posts on undeclared platforms', async () => {
    const f = fixture()
    const partial = f.video('partial', { posted: ['youtube'] })
    const staggered = f.video('staggered')
    f.db
      .prepare("UPDATE posts SET posted_at = ? WHERE job_id = 'staggered' AND platform = 'tiktok'")
      .run('2026-09-28T12:00:00.001Z')
    const complete = f.video('complete')
    seedPost(f.db, { jobId: 'complete', channel: 'alpha', platform: 'instagram' })
    await f.makeUnit()()
    expect(existsSync(partial)).toBe(true)
    expect(existsSync(staggered)).toBe(true)
    expect(existsSync(complete)).toBe(false)
  })

  it('preserves the timer on URL correction and restarts it after unmark/re-mark', async () => {
    const f = fixture(['youtube'])
    const corrected = f.video('corrected')
    const unmarked = f.video('unmarked')
    markPosted(f.db, {
      jobId: 'corrected',
      platform: 'youtube',
      url: 'https://example.com/corrected',
      time: f.time,
    })
    unmarkPosted(f.db, 'unmarked', 'youtube')
    const unit = f.makeUnit()
    await unit()
    expect(existsSync(corrected)).toBe(false)
    expect(existsSync(unmarked)).toBe(true)
    markPosted(f.db, { jobId: 'unmarked', platform: 'youtube', time: f.time })
    f.time.setNow(new Date('2026-09-30T11:59:59.999Z'))
    await unit()
    expect(existsSync(unmarked)).toBe(true)
    f.time.setNow(new Date('2026-09-30T12:00:00.000Z'))
    await f.makeUnit()()
    expect(existsSync(unmarked)).toBe(false)
  })

  it('checks on startup, throttles for five minutes, and catches up after restart', async () => {
    const f = fixture()
    const unit = f.makeUnit()
    await unit()
    const path = f.video()
    await f.time.advanceBy(299_999)
    await unit()
    expect(existsSync(path)).toBe(true)
    await f.time.advanceBy(1)
    await unit()
    expect(existsSync(path)).toBe(false)
    const overdue = f.video('overdue', { age: 172_800_000, legacy: true })
    await f.makeUnit()()
    expect(existsSync(overdue)).toBe(false)
    expect(f.time.pendingTimerCount()).toBe(0)
  })

  it('uses current channel platforms and skips empty or missing configurations', async () => {
    const f = fixture(['youtube'])
    const path = f.video()
    const unknown = f.video('unknown', { channel: 'removed' })
    const unit = f.makeUnit()
    f.configure(['youtube', 'tiktok'])
    await unit()
    expect(existsSync(path)).toBe(true)
    f.configure([])
    await f.time.advanceBy(300_000)
    await unit()
    expect(existsSync(path)).toBe(true)
    f.configure(['youtube'])
    await f.time.advanceBy(300_000)
    await unit()
    expect(existsSync(path)).toBe(false)
    expect(existsSync(unknown)).toBe(true)
  })

  it('skips the entire pass on invalid configuration', async () => {
    const f = fixture()
    const path = f.video()
    writeFileSync(join(f.channelsDir, 'broken.toml'), 'invalid = [')
    const result = await f.makeUnit()()
    expect(existsSync(path)).toBe(true)
    expect(result.line).toMatchObject({ reason: 'config-error' })
  })

  it('leaves unfinished and retired jobs alone', async () => {
    const f = fixture()
    const paths = ['queued', 'running', 'failed', 'blocked'].map((status) =>
      f.video(status, { status }),
    )
    paths.push(f.video('retired'))
    f.db
      .prepare("UPDATE jobs SET deleted_at = ? WHERE id = 'retired'")
      .run(f.time.now().toISOString())
    await f.makeUnit()()
    expect(paths.map(existsSync)).toEqual([true, true, true, true, true])
  })

  it('treats missing files as harmless and continues with other videos', async () => {
    const f = fixture()
    const missing = f.video('missing')
    rmSync(missing)
    const present = f.video('present')
    const unit = f.makeUnit()
    expect((await unit()).line).toMatchObject({ errors: [] })
    expect(existsSync(present)).toBe(false)
    await f.time.advanceBy(300_000)
    expect(await unit()).toEqual({ worked: false })
  })

  it.each([
    'outside',
    'other-job',
    'extension',
    'directory',
    'file-symlink',
    'parent-symlink',
    'job-symlink',
  ])('rejects unsafe file paths: %s', async (kind) => {
    const f = fixture()
    const original = f.video()
    const target = f.video('other')
    unmarkPosted(f.db, 'other', 'youtube')
    let unsafe = original
    if (kind === 'outside') {
      unsafe = join(f.channelsDir, 'final.mp4')
      writeFileSync(unsafe, 'keep')
    } else if (kind === 'other-job') {
      unsafe = target
    } else if (kind === 'extension') {
      unsafe = join(dirname(original), 'metadata.json')
      writeFileSync(unsafe, '{}')
    } else if (kind === 'directory') {
      rmSync(original)
      mkdirSync(original)
    } else if (kind === 'file-symlink') {
      rmSync(original)
      symlinkSync(target, original)
    } else if (kind === 'parent-symlink') {
      rmSync(dirname(original), { recursive: true })
      symlinkSync(dirname(target), dirname(original))
    } else {
      const jobRoot = join(f.runsRoot, 'job-1')
      renameSync(jobRoot, join(f.channelsDir, 'moved-job'))
      symlinkSync(join(f.channelsDir, 'moved-job'), jobRoot)
    }
    f.db.prepare("UPDATE library SET video_path = ? WHERE job_id = 'job-1'").run(unsafe)
    const result = await f.makeUnit()()
    expect(existsSync(unsafe)).toBe(true)
    expect(existsSync(target)).toBe(true)
    expect(result.line).toMatchObject({
      deleted: [],
      errors: [{ jobId: 'job-1', videoPath: unsafe, error: expect.any(String) }],
    })
  })

  it('logs deletion failures, continues, and retries on the next pass', async () => {
    const f = fixture()
    const blocked = f.video('blocked-file')
    const other = f.video('other')
    const unit = f.makeUnit()
    chmodSync(dirname(blocked), 0o555)
    try {
      const result = await unit()
      expect(existsSync(blocked)).toBe(true)
      expect(existsSync(other)).toBe(false)
      expect(result.line).toMatchObject({
        errors: [{ jobId: 'blocked-file', error: expect.any(String) }],
      })
    } finally {
      chmodSync(dirname(blocked), 0o755)
    }
    await f.time.advanceBy(300_000)
    await unit()
    expect(existsSync(blocked)).toBe(false)
  })

  it('refuses deletion after losing daemon ownership', async () => {
    const f = fixture()
    const path = f.video()
    const lease = requireLease(f.db, 'daemon', undefined, { time: f.time })
    const unit = f.makeUnit(lease)
    lease.release()
    await expect(unit()).rejects.toThrow('ownership of daemon lease was lost')
    expect(existsSync(path)).toBe(true)
  })

  it('rechecks posting eligibility immediately before deleting a selected video', async () => {
    const f = fixture()
    const path = f.video()
    const lease = requireLease(f.db, 'daemon', undefined, { time: f.time })
    const unit = f.makeUnit(lease)
    // Interleave an unmark at the ownership boundary, after candidate selection.
    const assertOwned = lease.assertOwned.bind(lease)
    vi.spyOn(lease, 'assertOwned').mockImplementation(() => {
      assertOwned()
      unmarkPosted(f.db, 'job-1', 'youtube')
    })
    try {
      await unit()
      expect(existsSync(path)).toBe(true)
    } finally {
      lease.release()
    }
  })
})
