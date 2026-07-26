import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Database } from 'better-sqlite3'
import { openDb } from '../db/index.js'
import { parseTokenKey } from '../publish/crypto.js'
import { claimPublish, markPublishDone } from '../publish/publishes.js'
import { upsertToken } from '../publish/tokens.js'
import { runCli } from '../testing/run-cli.js'
import type { Platform, PublishTarget } from '../publish/types.js'
import { PublishOutcomeUnknownError, YT_UPLOAD_SCOPE } from '../publish/youtube.js'
import { acquireLease, PUBLISH_LEASE_TTL_MS } from './lease.js'
import { publishNextTick } from './publish-next.js'

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

// Local-time constructor (month is 0-based): 2026-07-22 14:05 machine-local.
// Never string-parse datetimes in these tests — 'YYYY-MM-DDTHH:MM' parses
// local while '...Z' parses UTC, and mixing the two makes assertions
// timezone-dependent.
const NOW = () => new Date(2026, 6, 22, 14, 5)
const TEST_TOKEN_KEY_HEX = 'ab'.repeat(32)

const cleanupDirs: string[] = []
function tmpDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix))
  cleanupDirs.push(d)
  return d
}
afterAll(() => {
  for (const d of cleanupDirs) rmSync(d, { recursive: true, force: true })
})

// Plan-1-shape channel TOML plus an optional [publish] table (spec §3.3).
function channelToml(opts: { name: string; slots?: string[] }): string {
  const lines = [
    `name = "${opts.name}"`,
    'niche = ["space facts"]',
    'bg_dir = "assets/bg"',
    'bgm_dir = "assets/bgm"',
    'videos_per_day = 2',
    '',
    '[voice]',
    'volume = "af_heart"',
    '',
    '[caption_style]',
    'font = "Inter"',
    'font_size_px = 72',
    'active_color = "#FFD700"',
    'inactive_color = "#FFFFFF"',
    'stroke_px = 8',
    '',
    '[budget]',
    'per_video_usd = 8.0',
    'per_day_usd = 20.0',
  ]
  if (opts.slots !== undefined) {
    lines.push('', '[publish]', `slots = [${opts.slots.map((s) => `"${s}"`).join(', ')}]`)
  }
  return lines.join('\n')
}

function writeChannel(dir: string, opts: { name: string; slots?: string[] }): void {
  writeFileSync(join(dir, `${opts.name}.toml`), channelToml(opts))
}

// The candidate scan pre-flights video_path with existsSync (a pruned runs/
// tree must never burn a slot), so a publishable fixture needs a real file
// on disk. `videoExists: false` seeds the pruned case: the library row still
// points at a path, but nothing is there.
let videoRoot: string | undefined
let jobSeq = 0
function seedReadyVideo(
  db: Database,
  opts: {
    channel: string
    metadataJson?: string
    topic?: string
    videoExists?: boolean
    createdAt?: string
  },
): string {
  jobSeq += 1
  const jobId = `job-${jobSeq}`
  db.prepare(
    "INSERT INTO jobs (id, channel, tier, topic, status) VALUES (?, ?, 'volume', ?, 'done')",
  ).run(jobId, opts.channel, opts.topic ?? 'A test topic')
  videoRoot ??= tmpDir('brainrot-publish-videos-')
  const videoPath = join(videoRoot, `${jobId}.mp4`)
  if (opts.videoExists !== false) writeFileSync(videoPath, 'fake video bytes')
  // created_at is explicit only where a test pins eligibleVideo's newest-first
  // tiebreak; otherwise the column default stands.
  db.prepare(
    'INSERT INTO library (job_id, video_path, metadata_json, state, created_at) VALUES (?, ?, ?, ?, ?)',
  ).run(
    jobId,
    videoPath,
    opts.metadataJson ?? '{}',
    'ready',
    opts.createdAt ?? new Date().toISOString(),
  )
  return jobId
}

function seedToken(db: Database, channel: string): void {
  const key = parseTokenKey(TEST_TOKEN_KEY_HEX)
  upsertToken(db, 'youtube', channel, 'rt-test-token', YT_UPLOAD_SCOPE, key)
}

function seedConsumedSlot(
  db: Database,
  opts: { channel: string; platform: Platform; day: string; slot: string; status?: string },
): void {
  db.prepare(
    'INSERT INTO publishes (job_id, platform, channel, day, slot, status, attempt) VALUES (?, ?, ?, ?, ?, ?, 1)',
  ).run(
    `consumed-${opts.channel}-${opts.slot}`,
    opts.platform,
    opts.channel,
    opts.day,
    opts.slot,
    opts.status ?? 'done',
  )
}

function seedQuotaRows(db: Database, opts: { count: number; status?: string }): void {
  for (let i = 0; i < opts.count; i++) {
    db.prepare(
      "INSERT INTO publishes (job_id, platform, channel, day, slot, status, attempt) VALUES (?, 'youtube', 'quota-chan', '2026-07-22', ?, ?, 1)",
    ).run(`quota-job-${i}`, `0${i}:00`, opts.status ?? 'done')
  }
}

function fakeTokenFetch(): typeof fetch {
  const impl: typeof fetch = async () =>
    new Response(JSON.stringify({ access_token: 'fake-access-token', expires_in: 3600 }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  return impl
}

function fakeTarget(upload: PublishTarget['upload']): PublishTarget {
  return { platformId: 'youtube', upload }
}

beforeEach(() => {
  vi.stubEnv('YT_CLIENT_ID', 'test-client-id')
  vi.stubEnv('YT_CLIENT_SECRET', 'test-client-secret')
  vi.stubEnv('BRAINROT_TOKEN_KEY', TEST_TOKEN_KEY_HEX)
  vi.stubEnv('BRAINROT_YT_UPLOADS_PER_DAY', '')
})
afterEach(() => {
  vi.unstubAllEnvs()
})

describe('publishNextTick — gates', () => {
  it('no-ops with reason no-due-slot when no channel has publishing configured', async () => {
    const db = openDb(':memory:')
    const channelsDir = tmpDir('brainrot-publish-nodue-')
    writeChannel(channelsDir, { name: 'chan-a' })
    const result = await publishNextTick(db, { channelsDir, now: NOW })
    expect(result).toEqual({ action: 'noop', reason: 'no-due-slot' })
    db.close()
  })

  it('no-ops with reason platform-quota once the default cap of 6 is met', async () => {
    const db = openDb(':memory:')
    const channelsDir = tmpDir('brainrot-publish-quota-')
    writeChannel(channelsDir, { name: 'chan-a', slots: ['14:00'] })
    seedQuotaRows(db, { count: 6 })
    const result = await publishNextTick(db, { channelsDir, now: NOW })
    expect(result).toEqual({ action: 'noop', reason: 'platform-quota' })
    db.close()
  })

  it('honors the BRAINROT_YT_UPLOADS_PER_DAY override for the cap', async () => {
    const db = openDb(':memory:')
    const channelsDir = tmpDir('brainrot-publish-quota-override-')
    writeChannel(channelsDir, { name: 'chan-a', slots: ['14:00'] })
    seedQuotaRows(db, { count: 1 })
    vi.stubEnv('BRAINROT_YT_UPLOADS_PER_DAY', '1')
    const result = await publishNextTick(db, { channelsDir, now: NOW })
    expect(result).toEqual({ action: 'noop', reason: 'platform-quota' })
    db.close()
  })

  it('no-ops with reason no-ready-video when the channel has a due slot but an empty library', async () => {
    const db = openDb(':memory:')
    const channelsDir = tmpDir('brainrot-publish-novideo-')
    writeChannel(channelsDir, { name: 'chan-a', slots: ['14:00'] })
    const result = await publishNextTick(db, { channelsDir, now: NOW })
    expect(result).toEqual({ action: 'noop', reason: 'no-ready-video' })
    db.close()
  })

  it('no-ops with reason no-auth when the YouTube client credentials are unset', async () => {
    const db = openDb(':memory:')
    const channelsDir = tmpDir('brainrot-publish-noauth-env-')
    writeChannel(channelsDir, { name: 'chan-a', slots: ['14:00'] })
    seedReadyVideo(db, { channel: 'chan-a' })
    vi.stubEnv('YT_CLIENT_ID', '')
    const result = await publishNextTick(db, { channelsDir, now: NOW })
    expect(result).toEqual({ action: 'noop', reason: 'no-auth' })
    db.close()
  })

  it('no-ops with reason no-auth when no oauth token row exists for the channel', async () => {
    const db = openDb(':memory:')
    const channelsDir = tmpDir('brainrot-publish-noauth-token-')
    writeChannel(channelsDir, { name: 'chan-a', slots: ['14:00'] })
    seedReadyVideo(db, { channel: 'chan-a' })
    const result = await publishNextTick(db, { channelsDir, now: NOW })
    expect(result).toEqual({ action: 'noop', reason: 'no-auth' })
    db.close()
  })

  // A malformed env var used to throw out of the tick — exit 1, no JSON line,
  // every firing, with no DB trace. Unset, the same vars degrade gracefully,
  // so present-but-invalid must too.
  it('no-ops with reason bad-env on a malformed BRAINROT_TOKEN_KEY, naming the variable but never its value', async () => {
    const db = openDb(':memory:')
    const channelsDir = tmpDir('brainrot-publish-badkey-')
    writeChannel(channelsDir, { name: 'chan-a', slots: ['14:00'] })
    seedReadyVideo(db, { channel: 'chan-a' })
    const badKey = 'ab'.repeat(31) + 'a' // 63 hex chars: one short of a 32-byte key
    vi.stubEnv('BRAINROT_TOKEN_KEY', badKey)
    const result = await publishNextTick(db, { channelsDir, now: NOW })
    expect(result.action).toBe('noop')
    expect(result.reason).toBe('bad-env')
    expect(result.error).toContain('BRAINROT_TOKEN_KEY')
    expect(result.error).not.toContain(badKey)
    // Validated before any lease or candidate work: nothing was claimed and
    // the lease is free for the next firing.
    expect(db.prepare("SELECT * FROM leases WHERE name = 'publish'").get()).toBeUndefined()
    expect(db.prepare('SELECT COUNT(*) AS n FROM publishes').get()).toEqual({ n: 0 })
    db.close()
  })

  it('no-ops with reason bad-env on an unparseable BRAINROT_YT_UPLOADS_PER_DAY', async () => {
    const db = openDb(':memory:')
    const channelsDir = tmpDir('brainrot-publish-badcap-')
    writeChannel(channelsDir, { name: 'chan-a', slots: ['14:00'] })
    seedReadyVideo(db, { channel: 'chan-a' })
    vi.stubEnv('BRAINROT_YT_UPLOADS_PER_DAY', 'six')
    const result = await publishNextTick(db, { channelsDir, now: NOW })
    expect(result.action).toBe('noop')
    expect(result.reason).toBe('bad-env')
    expect(result.error).toContain('BRAINROT_YT_UPLOADS_PER_DAY')
    expect(result.error).not.toContain('six')
    db.close()
  })
})

describe('publishNextTick — candidate selection (dry-run)', () => {
  it('skips a blocked channel and previews the next eligible one', async () => {
    const db = openDb(':memory:')
    const channelsDir = tmpDir('brainrot-publish-iter-')
    writeChannel(channelsDir, { name: 'chan-a', slots: ['14:00'] })
    writeChannel(channelsDir, { name: 'chan-b', slots: ['14:00'] })
    const jobId = seedReadyVideo(db, { channel: 'chan-b', topic: 'Chan B topic' })
    seedToken(db, 'chan-b')
    const result = await publishNextTick(db, { channelsDir, now: NOW, dryRun: true })
    expect(result).toEqual({
      action: 'dry-run',
      wouldPublish: {
        channel: 'chan-b',
        platform: 'youtube',
        slot: '14:00',
        jobId,
        title: 'Chan B topic',
      },
    })
    db.close()
  })

  it('reports the first candidate blocker when every channel is blocked', async () => {
    const db = openDb(':memory:')
    const channelsDir = tmpDir('brainrot-publish-blocked-')
    writeChannel(channelsDir, { name: 'chan-a', slots: ['14:00'] })
    writeChannel(channelsDir, { name: 'chan-b', slots: ['14:00'] })
    seedReadyVideo(db, { channel: 'chan-b' })
    // chan-b has a video but no token; chan-a has no video at all. chan-a
    // sorts first (tied fraction, tied slot, channel ASC) so its blocker wins.
    const result = await publishNextTick(db, { channelsDir, now: NOW, dryRun: true })
    expect(result).toEqual({ action: 'dry-run', wouldPublish: null, reason: 'no-ready-video' })
    db.close()
  })

  // A pruned runs/ tree leaves a 'ready' library row pointing at nothing.
  // Without the pre-flight the claim happens first and the ENOENT comes back
  // as 'rejected' — three burnt slots and three quota units before the
  // poison cap retires the row.
  it('skips a ready video whose file is gone and reports no-video-file', async () => {
    const db = openDb(':memory:')
    const channelsDir = tmpDir('brainrot-publish-nofile-')
    writeChannel(channelsDir, { name: 'chan-a', slots: ['14:00'] })
    seedReadyVideo(db, { channel: 'chan-a', videoExists: false })
    seedToken(db, 'chan-a')
    const result = await publishNextTick(db, { channelsDir, now: NOW, dryRun: true })
    expect(result).toEqual({ action: 'dry-run', wouldPublish: null, reason: 'no-video-file' })
    db.close()
  })

  it('falls through to a channel whose file is present when an earlier one is pruned', async () => {
    const db = openDb(':memory:')
    const channelsDir = tmpDir('brainrot-publish-nofile-fallthrough-')
    writeChannel(channelsDir, { name: 'chan-a', slots: ['14:00'] })
    writeChannel(channelsDir, { name: 'chan-b', slots: ['14:00'] })
    seedReadyVideo(db, { channel: 'chan-a', videoExists: false })
    seedToken(db, 'chan-a')
    const jobB = seedReadyVideo(db, { channel: 'chan-b', topic: 'Chan B topic' })
    seedToken(db, 'chan-b')
    const result = await publishNextTick(db, { channelsDir, now: NOW, dryRun: true })
    expect(result).toEqual({
      action: 'dry-run',
      wouldPublish: {
        channel: 'chan-b',
        platform: 'youtube',
        slot: '14:00',
        jobId: jobB,
        title: 'Chan B topic',
      },
    })
    db.close()
  })

  // eligibleVideo returns ONE row, so a pruned newest video would otherwise
  // shadow every older healthy video on its channel forever: the scan skipped
  // the whole candidate and the next tick re-picked the same dead row. The
  // scan now re-queries with the pruned job excluded until it finds a file.
  it('publishes an older ready video when the newest one on the channel is pruned', async () => {
    const db = openDb(':memory:')
    const channelsDir = tmpDir('brainrot-publish-shadow-')
    writeChannel(channelsDir, { name: 'chan-a', slots: ['14:00'] })
    const older = seedReadyVideo(db, {
      channel: 'chan-a',
      topic: 'Older topic',
      createdAt: '2026-07-20T00:00:00.000Z',
    })
    seedReadyVideo(db, {
      channel: 'chan-a',
      topic: 'Newest topic',
      createdAt: '2026-07-21T00:00:00.000Z',
      videoExists: false,
    })
    seedToken(db, 'chan-a')
    const target = fakeTarget(async () => ({
      postId: 'yt-old',
      url: 'https://youtube.com/shorts/yt-old',
    }))
    const result = await publishNextTick(db, {
      channelsDir,
      now: NOW,
      target,
      fetchImpl: fakeTokenFetch(),
    })
    expect(result).toEqual({
      action: 'published',
      channel: 'chan-a',
      platform: 'youtube',
      jobId: older,
      slot: '14:00',
      postId: 'yt-old',
      url: 'https://youtube.com/shorts/yt-old',
    })
    db.close()
  })

  it('reports no-video-file only once every ready video on the channel is pruned', async () => {
    const db = openDb(':memory:')
    const channelsDir = tmpDir('brainrot-publish-shadow-all-')
    writeChannel(channelsDir, { name: 'chan-a', slots: ['14:00'] })
    seedReadyVideo(db, {
      channel: 'chan-a',
      createdAt: '2026-07-20T00:00:00.000Z',
      videoExists: false,
    })
    seedReadyVideo(db, {
      channel: 'chan-a',
      createdAt: '2026-07-21T00:00:00.000Z',
      videoExists: false,
    })
    seedToken(db, 'chan-a')
    const result = await publishNextTick(db, { channelsDir, now: NOW })
    expect(result).toEqual({ action: 'noop', reason: 'no-video-file' })
    expect(db.prepare('SELECT COUNT(*) AS n FROM publishes').get()).toEqual({ n: 0 })
    db.close()
  })

  it('picks the emptier channel over the fuller one regardless of name order', async () => {
    const db = openDb(':memory:')
    const channelsDir = tmpDir('brainrot-publish-fair-')
    writeChannel(channelsDir, { name: 'chan-a', slots: ['09:00', '14:00'] })
    writeChannel(channelsDir, { name: 'chan-b', slots: ['14:00'] })
    seedConsumedSlot(db, {
      channel: 'chan-a',
      platform: 'youtube',
      day: '2026-07-22',
      slot: '09:00',
    })
    seedReadyVideo(db, { channel: 'chan-a', topic: 'Chan A topic' })
    seedToken(db, 'chan-a')
    const jobB = seedReadyVideo(db, { channel: 'chan-b', topic: 'Chan B topic' })
    seedToken(db, 'chan-b')
    const result = await publishNextTick(db, { channelsDir, now: NOW, dryRun: true })
    expect(result).toEqual({
      action: 'dry-run',
      wouldPublish: {
        channel: 'chan-b',
        platform: 'youtube',
        slot: '14:00',
        jobId: jobB,
        title: 'Chan B topic',
      },
    })
    db.close()
  })
})

describe('publishNextTick — publish', () => {
  it('publishes the eligible video: publishes row done, library flipped, result fields set', async () => {
    const db = openDb(':memory:')
    const channelsDir = tmpDir('brainrot-publish-happy-')
    writeChannel(channelsDir, { name: 'chan-a', slots: ['14:00'] })
    const jobId = seedReadyVideo(db, {
      channel: 'chan-a',
      metadataJson: JSON.stringify({
        youtube: { title: 'Great Video', description: 'desc', hashtags: ['#space'] },
      }),
    })
    seedToken(db, 'chan-a')
    const target = fakeTarget(async () => ({
      postId: 'yt123',
      url: 'https://youtube.com/shorts/yt123',
    }))
    const result = await publishNextTick(db, {
      channelsDir,
      now: NOW,
      target,
      fetchImpl: fakeTokenFetch(),
    })
    expect(result).toEqual({
      action: 'published',
      channel: 'chan-a',
      platform: 'youtube',
      jobId,
      slot: '14:00',
      postId: 'yt123',
      url: 'https://youtube.com/shorts/yt123',
    })
    const row = db
      .prepare('SELECT status, post_id, url FROM publishes WHERE job_id = ?')
      .get(jobId) as {
      status: string
      post_id: string
      url: string
    }
    expect(row).toEqual({
      status: 'done',
      post_id: 'yt123',
      url: 'https://youtube.com/shorts/yt123',
    })
    const lib = db.prepare('SELECT state FROM library WHERE job_id = ?').get(jobId) as {
      state: string
    }
    expect(lib.state).toBe('published')
    expect(acquireLease(db, 'publish', 'pid:probe', PUBLISH_LEASE_TTL_MS)).toBe(true)
    db.close()
  })

  it('marks a rejected upload failed, keeps the video ready, and reports publish-failed', async () => {
    const db = openDb(':memory:')
    const channelsDir = tmpDir('brainrot-publish-fail-')
    writeChannel(channelsDir, { name: 'chan-a', slots: ['14:00'] })
    const jobId = seedReadyVideo(db, { channel: 'chan-a' })
    seedToken(db, 'chan-a')
    const { PublishError } = await import('../publish/types.js')
    const target = fakeTarget(async () => {
      throw new PublishError('upload: invalid metadata', 'rejected')
    })
    const result = await publishNextTick(db, {
      channelsDir,
      now: NOW,
      target,
      fetchImpl: fakeTokenFetch(),
    })
    expect(result).toEqual({
      action: 'publish-failed',
      channel: 'chan-a',
      platform: 'youtube',
      jobId,
      slot: '14:00',
      error: 'upload: invalid metadata',
    })
    const row = db
      .prepare('SELECT status, error_kind FROM publishes WHERE job_id = ?')
      .get(jobId) as {
      status: string
      error_kind: string
    }
    expect(row).toEqual({ status: 'failed', error_kind: 'rejected' })
    const lib = db.prepare('SELECT state FROM library WHERE job_id = ?').get(jobId) as {
      state: string
    }
    expect(lib.state).toBe('ready')
    db.close()
  })

  it('maps a non-PublishError from the adapter to error_kind transient', async () => {
    const db = openDb(':memory:')
    const channelsDir = tmpDir('brainrot-publish-transient-')
    writeChannel(channelsDir, { name: 'chan-a', slots: ['14:00'] })
    const jobId = seedReadyVideo(db, { channel: 'chan-a' })
    seedToken(db, 'chan-a')
    const target = fakeTarget(async () => {
      throw new Error('boom')
    })
    const result = await publishNextTick(db, {
      channelsDir,
      now: NOW,
      target,
      fetchImpl: fakeTokenFetch(),
    })
    expect(result.action).toBe('publish-failed')
    const row = db.prepare('SELECT error_kind FROM publishes WHERE job_id = ?').get(jobId) as {
      error_kind: string
    }
    expect(row.error_kind).toBe('transient')
    db.close()
  })

  // The upload landed — the video is public — and only the finalize write
  // failed. Marking the row failed would put the same job back in the
  // eligibility pool and publish it a second time, so the row stays claimed
  // and the repair sweep heals it to 'interrupted' for `publish mark-done`.
  it('leaves the row claimed when the finalize write throws after a live upload', async () => {
    const db = openDb(':memory:')
    const channelsDir = tmpDir('brainrot-publish-finalize-throw-')
    writeChannel(channelsDir, { name: 'chan-a', slots: ['14:00'] })
    const jobId = seedReadyVideo(db, { channel: 'chan-a' })
    seedToken(db, 'chan-a')
    const target = fakeTarget(async () => ({
      postId: 'yt-live-1',
      url: 'https://youtube.com/shorts/yt-live-1',
    }))
    vi.mocked(markPublishDone).mockImplementationOnce(() => {
      throw new Error('database is locked')
    })
    const result = await publishNextTick(db, {
      channelsDir,
      now: NOW,
      target,
      fetchImpl: fakeTokenFetch(),
    })
    expect(result.action).toBe('publish-failed')
    expect(result.jobId).toBe(jobId)
    // The post facts survive in the error text — the operator needs them to
    // confirm the upload in Studio and run `publish mark-done`.
    expect(result.error).toContain('yt-live-1')
    expect(result.error).toContain('https://youtube.com/shorts/yt-live-1')
    const row = db
      .prepare('SELECT status, error_kind FROM publishes WHERE job_id = ?')
      .get(jobId) as {
      status: string
      error_kind: string | null
    }
    expect(row).toEqual({ status: 'claimed', error_kind: null })
    const lib = db.prepare('SELECT state FROM library WHERE job_id = ?').get(jobId) as {
      state: string
    }
    expect(lib.state).toBe('ready')
    db.close()
  })

  // Same duplicate-upload hazard from the other side: YouTube accepted the
  // bytes but its success body was unreadable.
  it('leaves the row claimed when the adapter reports an unknown outcome', async () => {
    const db = openDb(':memory:')
    const channelsDir = tmpDir('brainrot-publish-unknown-outcome-')
    writeChannel(channelsDir, { name: 'chan-a', slots: ['14:00'] })
    const jobId = seedReadyVideo(db, { channel: 'chan-a' })
    seedToken(db, 'chan-a')
    const target = fakeTarget(async () => {
      throw new PublishOutcomeUnknownError(
        'youtubeTarget: accepted the upload but its success body carried no video id',
      )
    })
    const result = await publishNextTick(db, {
      channelsDir,
      now: NOW,
      target,
      fetchImpl: fakeTokenFetch(),
    })
    expect(result).toEqual({
      action: 'publish-failed',
      channel: 'chan-a',
      platform: 'youtube',
      jobId,
      slot: '14:00',
      error: 'youtubeTarget: accepted the upload but its success body carried no video id',
    })
    const row = db
      .prepare('SELECT status, error_kind FROM publishes WHERE job_id = ?')
      .get(jobId) as {
      status: string
      error_kind: string | null
    }
    expect(row).toEqual({ status: 'claimed', error_kind: null })
    const lib = db.prepare('SELECT state FROM library WHERE job_id = ?').get(jobId) as {
      state: string
    }
    expect(lib.state).toBe('ready')
    db.close()
  })

  it('stamps finished_at when the write happens, not when the tick started', async () => {
    const db = openDb(':memory:')
    const channelsDir = tmpDir('brainrot-publish-finished-at-')
    writeChannel(channelsDir, { name: 'chan-a', slots: ['14:00'] })
    const jobId = seedReadyVideo(db, { channel: 'chan-a' })
    seedToken(db, 'chan-a')
    // A clock that advances between the tick's planning read and the
    // finalize write, standing in for a multi-minute upload.
    const started = NOW()
    const finished = new Date(started.getTime() + 4 * 60_000)
    const clock = [started, finished]
    let call = 0
    const now = () => clock[Math.min(call++, clock.length - 1)]
    const target = fakeTarget(async () => ({
      postId: 'yt-slow-1',
      url: 'https://youtube.com/shorts/yt-slow-1',
    }))
    await publishNextTick(db, { channelsDir, now, target, fetchImpl: fakeTokenFetch() })
    const row = db.prepare('SELECT finished_at FROM publishes WHERE job_id = ?').get(jobId) as {
      finished_at: string
    }
    expect(row.finished_at).toBe(finished.toISOString())
    db.close()
  })

  it('no-ops with reason claim-conflict when a racing tick already claimed the slot', async () => {
    const db = openDb(':memory:')
    const channelsDir = tmpDir('brainrot-publish-conflict-')
    writeChannel(channelsDir, { name: 'chan-a', slots: ['14:00'] })
    seedReadyVideo(db, { channel: 'chan-a' })
    seedToken(db, 'chan-a')
    vi.mocked(claimPublish).mockReturnValueOnce(null)
    const result = await publishNextTick(db, { channelsDir, now: NOW })
    expect(result).toEqual({ action: 'noop', reason: 'claim-conflict' })
    db.close()
  })
})

describe('publishNextTick — lease and sweep', () => {
  it('no-ops with reason lease-held while another process holds the lease', async () => {
    const db = openDb(':memory:')
    const channelsDir = tmpDir('brainrot-publish-lease-')
    // Deliberately an empty library: the lease gate must short-circuit BEFORE
    // due-slot/candidate work even runs, so this fixture stays safe (no
    // mintAccessToken/network reachable) whether or not the gate is wired yet.
    writeChannel(channelsDir, { name: 'chan-a', slots: ['14:00'] })
    acquireLease(db, 'publish', 'pid:other', PUBLISH_LEASE_TTL_MS)
    const result = await publishNextTick(db, { channelsDir, now: NOW })
    expect(result).toEqual({ action: 'noop', reason: 'lease-held' })
    db.close()
  })

  it('releases the lease after a successful publish', async () => {
    const db = openDb(':memory:')
    const channelsDir = tmpDir('brainrot-publish-release-')
    writeChannel(channelsDir, { name: 'chan-a', slots: ['14:00'] })
    seedReadyVideo(db, { channel: 'chan-a' })
    seedToken(db, 'chan-a')
    const target = fakeTarget(async () => ({
      postId: 'yt1',
      url: 'https://youtube.com/shorts/yt1',
    }))
    await publishNextTick(db, { channelsDir, now: NOW, target, fetchImpl: fakeTokenFetch() })
    expect(acquireLease(db, 'publish', 'pid:probe', PUBLISH_LEASE_TTL_MS)).toBe(true)
    db.close()
  })

  it('releases the lease when the tick throws mid-flight', async () => {
    const db = openDb(':memory:')
    const channelsDir = tmpDir('brainrot-publish-throw-')
    writeChannel(channelsDir, { name: 'chan-a', slots: ['14:00'] })
    seedReadyVideo(db, { channel: 'chan-a' })
    seedToken(db, 'chan-a')
    // A throw from inside the leased window (here: the claim write) must still
    // release on the way out, so one crash cannot wedge publishing for a TTL.
    vi.mocked(claimPublish).mockImplementationOnce(() => {
      throw new Error('disk full')
    })
    const target = fakeTarget(async () => ({
      postId: 'yt1',
      url: 'https://youtube.com/shorts/yt1',
    }))
    await expect(
      publishNextTick(db, { channelsDir, now: NOW, target, fetchImpl: fakeTokenFetch() }),
    ).rejects.toThrow('disk full')
    expect(acquireLease(db, 'publish', 'pid:probe', PUBLISH_LEASE_TTL_MS)).toBe(true)
    db.close()
  })

  it('sweeps a stale claimed row to interrupted before planning the tick', async () => {
    const db = openDb(':memory:')
    const channelsDir = tmpDir('brainrot-publish-sweep-')
    writeChannel(channelsDir, { name: 'chan-a', slots: ['09:00'] })
    // Seed the stale claim RELATIVE to NOW (65 min ago > 30-min TTL) so the
    // age is identical in every timezone the suite runs in.
    db.prepare(
      'INSERT INTO publishes (job_id, platform, channel, day, slot, status, attempt, created_at) ' +
        "VALUES ('stale-job', 'youtube', 'chan-a', '2026-07-22', '09:00', 'claimed', 1, ?)",
    ).run(new Date(NOW().getTime() - 65 * 60_000).toISOString())
    const result = await publishNextTick(db, { channelsDir, now: NOW })
    expect(result).toEqual({ action: 'noop', reason: 'no-due-slot' })
    const row = db.prepare("SELECT status FROM publishes WHERE job_id = 'stale-job'").get() as {
      status: string
    }
    expect(row.status).toBe('interrupted')
    db.close()
  })

  it('dry-run never acquires the lease, never sweeps, and writes nothing', async () => {
    const db = openDb(':memory:')
    const channelsDir = tmpDir('brainrot-publish-dryrun-')
    writeChannel(channelsDir, { name: 'chan-a', slots: ['14:00'] })
    // Old enough that a real sweep WOULD flip it — proving dry-run skipped it.
    db.prepare(
      'INSERT INTO publishes (job_id, platform, channel, day, slot, status, attempt, created_at) ' +
        "VALUES ('stale-job', 'youtube', 'chan-a', '2026-07-21', '09:00', 'claimed', 1, ?)",
    ).run(new Date(NOW().getTime() - 65 * 60_000).toISOString())
    const jobId = seedReadyVideo(db, { channel: 'chan-a', topic: 'Preview me' })
    seedToken(db, 'chan-a')
    const result = await publishNextTick(db, { channelsDir, now: NOW, dryRun: true })
    expect(result).toEqual({
      action: 'dry-run',
      wouldPublish: {
        channel: 'chan-a',
        platform: 'youtube',
        slot: '14:00',
        jobId,
        title: 'Preview me',
      },
    })
    // the stale row from a DIFFERENT day is untouched: sweep never ran
    const stale = db.prepare("SELECT status FROM publishes WHERE job_id = 'stale-job'").get() as {
      status: string
    }
    expect(stale.status).toBe('claimed')
    // no new row for today's slot, no lease taken
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
    const db = openDb(':memory:')
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
    const db = openDb(':memory:')
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
    const db = openDb(':memory:')
    const brokenDir = tmpDir('brainrot-publish-broken-lease-')
    writeFileSync(join(brokenDir, 'broken.toml'), 'this is not toml [')
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => {})
    await publishNextTick(db, { channelsDir: brokenDir, now: NOW })
    // Never acquired, not merely released: a broken config cannot burn a lease
    // slot, and the sweep it would have run never touches rows either.
    expect(db.prepare("SELECT * FROM leases WHERE name = 'publish'").get()).toBeUndefined()
    expect(acquireLease(db, 'publish', 'pid:probe', PUBLISH_LEASE_TTL_MS)).toBe(true)
    stderr.mockRestore()
    db.close()
  })

  it('a healthy channels dir is unaffected: the tick publishes as before', async () => {
    const db = openDb(':memory:')
    const channelsDir = tmpDir('brainrot-publish-healthy-')
    writeChannel(channelsDir, { name: 'chan-a', slots: ['14:00'] })
    seedReadyVideo(db, { channel: 'chan-a' })
    seedToken(db, 'chan-a')
    const target = fakeTarget(async () => ({
      postId: 'yt1',
      url: 'https://youtube.com/shorts/yt1',
    }))
    const result = await publishNextTick(db, {
      channelsDir,
      now: NOW,
      target,
      fetchImpl: fakeTokenFetch(),
    })
    expect(result.action).toBe('published')
    expect(result.reason).toBeUndefined()
    db.close()
  })
})

describe('publish-next CLI', () => {
  it.concurrent(
    '`publish-next --help` prints usage with --db/--channels-dir/--dry-run',
    async () => {
      const result = await runCli(['publish-next', '--help'])
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain('--db')
      expect(result.stdout).toContain('--channels-dir')
      expect(result.stdout).toContain('--dry-run')
    },
    60000,
  )

  it.concurrent(
    '`publish-next` with no due slot prints one noop JSON line and exits 0',
    async () => {
      const root = tmpDir('brainrot-publish-cli-')
      const channelsDir = tmpDir('brainrot-publish-cli-channels-')
      writeChannel(channelsDir, { name: 'chan-a' })
      const result = await runCli([
        'publish-next',
        '--db',
        join(root, 'brainrot.db'),
        '--channels-dir',
        channelsDir,
      ])
      expect(result.exitCode).toBe(0)
      expect(result.stdout.trim().split('\n')).toHaveLength(1)
      expect(JSON.parse(result.stdout)).toEqual({ action: 'noop', reason: 'no-due-slot' })
    },
    60000,
  )

  it.concurrent(
    '`publish-next --dry-run` with no due slot prints one dry-run JSON line and exits 0',
    async () => {
      const root = tmpDir('brainrot-publish-cli-dry-')
      const channelsDir = tmpDir('brainrot-publish-cli-dry-channels-')
      writeChannel(channelsDir, { name: 'chan-a' })
      const result = await runCli([
        'publish-next',
        '--db',
        join(root, 'brainrot.db'),
        '--channels-dir',
        channelsDir,
        '--dry-run',
      ])
      expect(result.exitCode).toBe(0)
      expect(result.stdout.trim().split('\n')).toHaveLength(1)
      expect(JSON.parse(result.stdout)).toEqual({
        action: 'dry-run',
        wouldPublish: null,
        reason: 'no-due-slot',
      })
    },
    60000,
  )
})
