import { beforeEach, describe, expect, it, vi } from 'vitest'
import { publishNextTick } from './publish-next.js'
import {
  NOW,
  fakeIgAdapter,
  seedQuotaRows,
  seedReadyVideo,
  seedToken,
  stubPublishEnv,
  writeChannel,
} from './_publish-next.fixtures.js'
import { tmpDir } from '../testing/tmp.js'
import { memDb } from '../testing/db.js'

/**
 * The gates a candidate must clear before any upload: credentials, quota,
 * a present video file, and the cross-platform/pre-filter variants.
 *
 * Split from a single 1825-line publish-next.test.ts — the largest file in the
 * repo — whose eleven fixtures sat in a 300-line preamble. They now live in
 * _publish-next.fixtures.ts.
 */

beforeEach(() => {
  stubPublishEnv(vi)
})

describe('publishNextTick — gates', () => {
  // A channels dir where nothing declares [publish] produces no candidate and
  // no channel whose pacing gate closed — distinct from a pacing reason, so
  // it gets its own 'no-publish-channel' cause rather than a bare noop.
  it('no-ops with reason no-publish-channel when no channel has publishing configured', async () => {
    const db = memDb()
    const channelsDir = tmpDir('brainrot-publish-nodue-')
    writeChannel(channelsDir, { name: 'chan-a' })
    const result = await publishNextTick(db, { channelsDir, now: NOW })
    expect(result).toEqual({ action: 'noop', reason: 'no-publish-channel' })
    db.close()
  })

  it('no-ops with reason platform-quota once the default cap of 6 is met', async () => {
    const db = memDb()
    const channelsDir = tmpDir('brainrot-publish-quota-')
    writeChannel(channelsDir, { name: 'chan-a', publish: true })
    // A publishable, authorized video, so the cap is the ONLY thing stopping
    // this tick — an empty library would report 'no-ready-video' instead.
    seedReadyVideo(db, { channel: 'chan-a' })
    seedToken(db, 'chan-a')
    seedQuotaRows(db, { count: 6 })
    const result = await publishNextTick(db, { channelsDir, now: NOW })
    expect(result).toEqual({ action: 'noop', reason: 'platform-quota' })
    db.close()
  })

  it('honors the BRAINROT_YT_UPLOADS_PER_DAY override for the cap', async () => {
    const db = memDb()
    const channelsDir = tmpDir('brainrot-publish-quota-override-')
    // videosPerDay lowered to match the cap this test stubs to 1 below —
    // loadChannelsDir now rejects a channel declaring more youtube
    // videos/day than the (possibly env-overridden) cap allows.
    writeChannel(channelsDir, { name: 'chan-a', publish: true, videosPerDay: 1 })
    seedReadyVideo(db, { channel: 'chan-a' })
    seedToken(db, 'chan-a')
    seedQuotaRows(db, { count: 1 })
    vi.stubEnv('BRAINROT_YT_UPLOADS_PER_DAY', '1')
    const result = await publishNextTick(db, { channelsDir, now: NOW })
    expect(result).toEqual({ action: 'noop', reason: 'platform-quota' })
    db.close()
  })

  it('no-ops with reason no-ready-video when the channel is due but its library is empty', async () => {
    const db = memDb()
    const channelsDir = tmpDir('brainrot-publish-novideo-')
    writeChannel(channelsDir, { name: 'chan-a', publish: true })
    seedToken(db, 'chan-a')
    const result = await publishNextTick(db, { channelsDir, now: NOW })
    expect(result).toEqual({ action: 'noop', reason: 'no-ready-video' })
    db.close()
  })

  it('no-ops with reason no-auth when the YouTube client credentials are unset', async () => {
    const db = memDb()
    const channelsDir = tmpDir('brainrot-publish-noauth-env-')
    writeChannel(channelsDir, { name: 'chan-a', publish: true })
    seedReadyVideo(db, { channel: 'chan-a' })
    vi.stubEnv('YT_CLIENT_ID', '')
    const result = await publishNextTick(db, { channelsDir, now: NOW })
    expect(result).toEqual({ action: 'noop', reason: 'no-auth' })
    db.close()
  })

  it('no-ops with reason no-auth when no oauth token row exists for the channel', async () => {
    const db = memDb()
    const channelsDir = tmpDir('brainrot-publish-noauth-token-')
    writeChannel(channelsDir, { name: 'chan-a', publish: true })
    seedReadyVideo(db, { channel: 'chan-a' })
    const result = await publishNextTick(db, { channelsDir, now: NOW })
    expect(result).toEqual({ action: 'noop', reason: 'no-auth' })
    db.close()
  })

  // A malformed env var used to throw out of the tick — exit 1, no JSON line,
  // every firing, with no DB trace. Unset, the same vars degrade gracefully,
  // so present-but-invalid must too.
  it('no-ops with reason bad-env on a malformed BRAINROT_TOKEN_KEY, naming the variable but never its value', async () => {
    const db = memDb()
    const channelsDir = tmpDir('brainrot-publish-badkey-')
    writeChannel(channelsDir, { name: 'chan-a', publish: true })
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
    const db = memDb()
    const channelsDir = tmpDir('brainrot-publish-badcap-')
    writeChannel(channelsDir, { name: 'chan-a', publish: true })
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

describe('cross-platform candidates', () => {
  it('walks every declared target of a due channel, not just the first', async () => {
    // Channel with both youtube and instagram targets and a ready video: the
    // scan spans both platforms — verified via dry-run so no claim mutates
    // state. No stored token for either platform on a fresh db means neither
    // can be picked, but the fact that BOTH platforms were considered (not
    // just the first) is what this test guards, checked via the reason.
    const db = memDb()
    const channelsDir = tmpDir('brainrot-publish-crossplatform-')
    writeChannel(channelsDir, { name: 'chan', publish: true, instagram: true, videosPerDay: 1 })
    seedReadyVideo(db, { channel: 'chan' })
    const now = () => new Date(2026, 6, 22, 10, 0)
    const result = await publishNextTick(db, { channelsDir, now, dryRun: true })
    expect(result).toEqual({ action: 'dry-run', wouldPublish: null, reason: 'no-auth' })
    db.close()
  })
})

describe('quota pre-filter', () => {
  it('lets instagram publish when youtube alone is at its global cap', async () => {
    vi.stubEnv('BRAINROT_YT_UPLOADS_PER_DAY', '1')
    const db = memDb()
    const channelsDir = tmpDir('brainrot-publish-quota-prefilter-')
    writeChannel(channelsDir, { name: 'chan', publish: true, instagram: true, videosPerDay: 1 })
    seedReadyVideo(db, { channel: 'chan' })
    // A prior youtube upload today on ANOTHER channel: it counts toward the
    // global youtube quota (cap 1) without touching chan's own day count or
    // pacing clock.
    seedQuotaRows(db, { count: 1 })
    const igAdapter = fakeIgAdapter(async () => ({ postId: 'p1', url: 'https://ig/p1' }))
    const now = () => new Date(2026, 6, 22, 10, 0)
    const result = await publishNextTick(db, {
      channelsDir,
      now,
      adapters: { instagram: igAdapter },
    })
    expect(result.action).toBe('published')
    expect(result.results?.map((r) => r.platform)).toEqual(['instagram'])
    db.close()
  })

  it('noops with platform-quota when every due candidate is capped', async () => {
    vi.stubEnv('BRAINROT_YT_UPLOADS_PER_DAY', '1')
    const db = memDb()
    const channelsDir = tmpDir('brainrot-publish-quota-allcapped-')
    writeChannel(channelsDir, { name: 'chan', publish: true, videosPerDay: 1 })
    seedReadyVideo(db, { channel: 'chan' })
    seedQuotaRows(db, { count: 1 })
    const now = () => new Date(2026, 6, 22, 10, 0)
    const result = await publishNextTick(db, { channelsDir, now })
    expect(result).toEqual({ action: 'noop', reason: 'platform-quota' })
    db.close()
  })
})
