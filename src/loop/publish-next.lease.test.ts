import { beforeEach, describe, expect, it, vi } from 'vitest'
import { writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { claimPublish } from '../publish/publishes.js'
import { acquireLease, PUBLISH_LEASE_TTL_MS } from './lease.js'
import { publishNextTick } from './publish-next.js'
import {
  NOW,
  fakeAdapter,
  seedReadyVideo,
  seedToken,
  stubPublishEnv,
  writeChannel,
} from './_publish-next.fixtures.js'
import { tmpDir } from '../testing/tmp.js'
import { memDb } from '../testing/db.js'

/**
 * Lease acquisition, the interrupted-row sweep, and config-error noops.
 *
 * Split from a single 1825-line publish-next.test.ts — the largest file in the
 * repo — whose eleven fixtures sat in a 300-line preamble. They now live in
 * _publish-next.fixtures.ts.
 */

// Spies claimPublish so the claim-conflict test can force a `null` return
// (a racing-tick claim collision the publish lease makes unreachable in a
// single-process run), and markPublishDone so the post-upload DB-failure
// test can force a throw; every other test calls straight through to the
// real DAO because vi.fn wraps the actual implementation as its default.
vi.mock('../publish/publishes.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../publish/publishes.js')>()
  return {
    ...actual,
    claimPublish: vi.fn(actual.claimPublish),
    markPublishDone: vi.fn(actual.markPublishDone),
  }
})

beforeEach(() => {
  stubPublishEnv(vi)
})

describe('publishNextTick — lease and sweep', () => {
  it('no-ops with reason lease-held while another process holds the lease', async () => {
    const db = memDb()
    const channelsDir = tmpDir('brainrot-publish-lease-')
    // Deliberately an empty library: the lease gate must short-circuit BEFORE
    // any due/candidate work runs, so this fixture stays safe (no
    // mintAccessToken/network reachable) whether or not the gate is wired yet.
    writeChannel(channelsDir, { name: 'chan-a', publish: true })
    acquireLease(db, 'publish', 'pid:other', PUBLISH_LEASE_TTL_MS)
    const result = await publishNextTick(db, { channelsDir, now: NOW })
    expect(result).toEqual({ action: 'noop', reason: 'lease-held' })
    db.close()
  })

  it('releases the lease after a successful publish', async () => {
    const db = memDb()
    const channelsDir = tmpDir('brainrot-publish-release-')
    writeChannel(channelsDir, { name: 'chan-a', publish: true })
    seedReadyVideo(db, { channel: 'chan-a' })
    seedToken(db, 'chan-a')
    const target = fakeAdapter(async () => ({
      postId: 'yt1',
      url: 'https://youtube.com/shorts/yt1',
    }))
    await publishNextTick(db, { channelsDir, now: NOW, adapters: { youtube: target } })
    expect(acquireLease(db, 'publish', 'pid:probe', PUBLISH_LEASE_TTL_MS)).toBe(true)
    db.close()
  })

  it('releases the lease when the tick throws mid-flight', async () => {
    const db = memDb()
    const channelsDir = tmpDir('brainrot-publish-throw-')
    writeChannel(channelsDir, { name: 'chan-a', publish: true })
    seedReadyVideo(db, { channel: 'chan-a' })
    seedToken(db, 'chan-a')
    // A throw from inside the leased window (here: the claim write) must still
    // release on the way out, so one crash cannot wedge publishing for a TTL.
    vi.mocked(claimPublish).mockImplementationOnce(() => {
      throw new Error('disk full')
    })
    const target = fakeAdapter(async () => ({
      postId: 'yt1',
      url: 'https://youtube.com/shorts/yt1',
    }))
    await expect(
      publishNextTick(db, { channelsDir, now: NOW, adapters: { youtube: target } }),
    ).rejects.toThrow('disk full')
    expect(acquireLease(db, 'publish', 'pid:probe', PUBLISH_LEASE_TTL_MS)).toBe(true)
    db.close()
  })

  it('sweeps a stale claimed row to interrupted before planning the tick', async () => {
    const db = memDb()
    const channelsDir = tmpDir('brainrot-publish-sweep-')
    writeChannel(channelsDir, { name: 'chan-a', publish: true })
    // Seed the stale claim RELATIVE to NOW (65 min ago > 30-min TTL) so the
    // age is identical in every timezone the suite runs in. 65 min is also
    // inside the 6h min gap for videos_per_day = 2, so the planning half then
    // reports 'paced' — the point of the test is that the sweep ran first.
    db.prepare(
      'INSERT INTO publishes (job_id, platform, channel, day, seq, status, attempt, created_at) ' +
        "VALUES ('stale-job', 'youtube', 'chan-a', '2026-07-22', 1, 'claimed', 1, ?)",
    ).run(new Date(NOW().getTime() - 65 * 60_000).toISOString())
    const result = await publishNextTick(db, { channelsDir, now: NOW })
    expect(result).toEqual({ action: 'noop', reason: 'paced' })
    const row = db.prepare("SELECT status FROM publishes WHERE job_id = 'stale-job'").get() as {
      status: string
    }
    expect(row.status).toBe('interrupted')
    db.close()
  })

  it('dry-run never acquires the lease, never sweeps, and writes nothing', async () => {
    const db = memDb()
    const channelsDir = tmpDir('brainrot-publish-dryrun-')
    writeChannel(channelsDir, { name: 'chan-a', publish: true })
    // Old enough that a real sweep WOULD flip it — proving dry-run skipped it.
    // 26h back (not 65 min) so it also sits outside the channel's min gap and
    // the tick still reaches its preview.
    db.prepare(
      'INSERT INTO publishes (job_id, platform, channel, day, seq, status, attempt, created_at) ' +
        "VALUES ('stale-job', 'youtube', 'chan-a', '2026-07-21', 1, 'claimed', 1, ?)",
    ).run(new Date(NOW().getTime() - 26 * 3_600_000).toISOString())
    const jobId = seedReadyVideo(db, { channel: 'chan-a', topic: 'Preview me' })
    seedToken(db, 'chan-a')
    const result = await publishNextTick(db, { channelsDir, now: NOW, dryRun: true })
    expect(result).toEqual({
      action: 'dry-run',
      wouldPublish: {
        channel: 'chan-a',
        jobId,
        title: 'Preview me',
        platforms: ['youtube'],
      },
    })
    // the stale row from a DIFFERENT day is untouched: sweep never ran
    const stale = db.prepare("SELECT status FROM publishes WHERE job_id = 'stale-job'").get() as {
      status: string
    }
    expect(stale.status).toBe('claimed')
    // no new row for today, no lease taken
    const count = (
      db.prepare("SELECT COUNT(*) AS n FROM publishes WHERE day = '2026-07-22'").get() as {
        n: number
      }
    ).n
    expect(count).toBe(0)
    const lease = db.prepare("SELECT * FROM leases WHERE name = 'publish'").get()
    expect(lease).toBeUndefined()
    db.close()
  })
})

describe('publishNextTick — config errors', () => {
  it('no-ops with reason config-error on an unparseable channel TOML, naming the file on stderr', async () => {
    const db = memDb()
    const brokenDir = tmpDir('brainrot-publish-broken-')
    writeFileSync(join(brokenDir, 'broken.toml'), 'this is not toml [')
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => {})
    const result = await publishNextTick(db, { channelsDir: brokenDir, now: NOW })
    // One well-formed JSON line (exit 0 at the CLI) instead of a throw that
    // escaped with no line at all, every 15 minutes, until the file is fixed.
    expect(result.action).toBe('noop')
    expect(result.reason).toBe('config-error')
    expect(result.error).toContain('broken.toml')
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('broken.toml'))
    stderr.mockRestore()
    db.close()
  })

  it('no-ops with reason config-error when the channels dir does not exist', async () => {
    const db = memDb()
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => {})
    const result = await publishNextTick(db, {
      channelsDir: join(tmpdir(), 'brainrot-no-such-channels-dir'),
      now: NOW,
    })
    expect(result.action).toBe('noop')
    expect(result.reason).toBe('config-error')
    stderr.mockRestore()
    db.close()
  })

  it('never takes the publish lease on a broken config', async () => {
    const db = memDb()
    const brokenDir = tmpDir('brainrot-publish-broken-lease-')
    writeFileSync(join(brokenDir, 'broken.toml'), 'this is not toml [')
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => {})
    await publishNextTick(db, { channelsDir: brokenDir, now: NOW })
    // Never acquired, not merely released: a broken config cannot take a lease,
    // and the sweep it would have run never touches rows either.
    expect(db.prepare("SELECT * FROM leases WHERE name = 'publish'").get()).toBeUndefined()
    expect(acquireLease(db, 'publish', 'pid:probe', PUBLISH_LEASE_TTL_MS)).toBe(true)
    stderr.mockRestore()
    db.close()
  })

  it('a healthy channels dir is unaffected: the tick publishes as before', async () => {
    const db = memDb()
    const channelsDir = tmpDir('brainrot-publish-healthy-')
    writeChannel(channelsDir, { name: 'chan-a', publish: true })
    seedReadyVideo(db, { channel: 'chan-a' })
    seedToken(db, 'chan-a')
    const target = fakeAdapter(async () => ({
      postId: 'yt1',
      url: 'https://youtube.com/shorts/yt1',
    }))
    const result = await publishNextTick(db, {
      channelsDir,
      now: NOW,
      adapters: { youtube: target },
    })
    expect(result.action).toBe('published')
    expect(result.reason).toBeUndefined()
    db.close()
  })
})
