import { describe, expect, it, vi } from 'vitest'
import { upsertToken } from '../publish/tokens.js'
import { memDb } from '../testing/db.js'
import { testChannel } from '../testing/channel.js'
import { buildDigest } from './digest.js'
import {
  DAY_MS,
  ENV_OK,
  OTHER_KEY_HEX,
  publishChannel,
  seedJob,
  seedLibrary,
  seedLibraryPath,
  TEST_KEY,
} from './_digest.fixtures.js'

/**
 * Credential and stored-object health: publish token health, token expiry
 * warnings, and library rows with no stored object.
 *
 * Split from a single 964-line digest.test.ts whose fifteen describes already
 * mapped 1:1 onto sections of the digest's output. Shared seeds live in
 * _digest.fixtures.ts.
 */

describe('buildDigest — publish token health', () => {
  it('tells the operator to authorize a publish-enabled channel with no stored token', () => {
    const db = memDb()
    const digest = buildDigest(db, [publishChannel('chan-a')], ENV_OK)
    expect(digest).toContain(
      '  chan-a youtube: no stored token — run brainrot auth youtube --channel chan-a',
    )
    db.close()
  })

  it('names the key rotation when a stored token no longer decrypts', () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
    const db = memDb()
    upsertToken(db, 'youtube', 'chan-a', 'rt-test-token', 'scope', TEST_KEY)
    const digest = buildDigest(db, [publishChannel('chan-a')], {
      ...ENV_OK,
      tokenKeyHex: OTHER_KEY_HEX,
    })
    expect(digest).toContain(
      '  chan-a youtube: the stored token does not decrypt with the current BRAINROT_TOKEN_KEY — run brainrot auth youtube --channel chan-a',
    )
    db.close()
    stderr.mockRestore()
  })

  it('says nothing about tokens when the grant is healthy', () => {
    const db = memDb()
    upsertToken(db, 'youtube', 'chan-a', 'rt-test-token', 'scope', TEST_KEY)
    const digest = buildDigest(db, [publishChannel('chan-a')], ENV_OK)
    expect(digest).not.toContain('chan-a youtube: no stored token')
    expect(digest).not.toContain('does not decrypt')
    db.close()
  })

  it('lists the unset publish env vars once, by name', () => {
    const db = memDb()
    upsertToken(db, 'youtube', 'chan-a', 'rt-test-token', 'scope', TEST_KEY)
    const digest = buildDigest(db, [publishChannel('chan-a'), publishChannel('chan-b')], {
      ytClientIdPresent: false,
      ytClientSecretPresent: true,
      tokenKeyHex: undefined,
    })
    expect(digest).toContain(
      '  publishing is not configured: YT_CLIENT_ID, BRAINROT_TOKEN_KEY unset — every publish tick noops with reason no-auth',
    )
    // One line for the whole run, not one per channel.
    expect(digest.split('publishing is not configured').length).toBe(2)
    db.close()
  })

  it('flags a BRAINROT_TOKEN_KEY that is set but malformed without echoing it', () => {
    const db = memDb()
    const digest = buildDigest(db, [publishChannel('chan-a')], { ...ENV_OK, tokenKeyHex: 'nothex' })
    expect(digest).toContain(
      '  BRAINROT_TOKEN_KEY is set but is not 64 hex characters — stored tokens cannot be decrypted',
    )
    expect(digest).not.toContain('nothex')
    db.close()
  })

  it('checks no tokens for a channel without a publish config', () => {
    const db = memDb()
    const digest = buildDigest(db, [testChannel({ name: 'chan-b', publish: null })], ENV_OK)
    expect(digest).not.toContain('no stored token')
    expect(digest).not.toContain('publishing is not configured')
    db.close()
  })
})

describe('buildDigest — token expiry warning', () => {
  // buildDigest reads its own clock (new Date()), so these seed expiries
  // relative to Date.now() rather than an injected `now`.
  function instagramChannel(name: string) {
    return testChannel({
      name,
      publish: {
        targets: [
          {
            platform: 'instagram',
            options: { igUserId: 'ig-1', shareToFeed: true },
          },
        ],
      },
    })
  }

  it('warns when a stored token expires within the 3-day window', () => {
    const db = memDb()
    const channel = instagramChannel('chan-a')
    const soonExpiry = new Date(Date.now() + 2 * DAY_MS).toISOString()
    upsertToken(db, 'instagram', 'chan-a', 'tok', 'scope', TEST_KEY, soonExpiry)
    const digest = buildDigest(db, [channel], ENV_OK)
    expect(digest).toContain(`  chan-a instagram: stored token expires ${soonExpiry}`)
    db.close()
  })

  it('does not warn when expiry is far out', () => {
    const db = memDb()
    const channel = instagramChannel('chan-a')
    const farExpiry = new Date(Date.now() + 30 * DAY_MS).toISOString()
    upsertToken(db, 'instagram', 'chan-a', 'tok', 'scope', TEST_KEY, farExpiry)
    const digest = buildDigest(db, [channel], ENV_OK)
    expect(digest).not.toContain('stored token expires')
    db.close()
  })

  it('never warns for a null expiry (youtube)', () => {
    const db = memDb()
    const channel = publishChannel('chan-a')
    upsertToken(db, 'youtube', 'chan-a', 'rt', 'scope', TEST_KEY)
    const digest = buildDigest(db, [channel], ENV_OK)
    expect(digest).not.toContain('stored token expires')
    db.close()
  })
})

describe('buildDigest — library rows with no stored object', () => {
  it('flags a ready library row that has no library_objects row', () => {
    const db = memDb()
    seedJob(db, { id: 'j-unstored', channel: 'chan-a' })
    seedLibrary(db, 'j-unstored', 'ready')
    const digest = buildDigest(db, [], ENV_OK)
    expect(digest).toContain(
      '  job j-unstored (chan-a) has no stored object — run brainrot library backfill-store',
    )
    db.close()
  })

  it('does not flag a row whose local file is gone but is stored', () => {
    const db = memDb()
    seedJob(db, { id: 'j-stored', channel: 'chan-a' })
    seedLibraryPath(db, 'j-stored', '/nonexistent/runs/j-stored/final.mp4')
    db.prepare(
      "INSERT INTO library_objects (job_id, object_key, bytes, etag) VALUES ('j-stored','k',1,'e')",
    ).run()
    const digest = buildDigest(db, [], ENV_OK)
    expect(digest).not.toContain('j-stored')
    db.close()
  })

  // This line names `backfill-store`, so it must report exactly what that
  // command uploads — both now read unstoredLibraryJobs (src/jobs/library.ts).
  // A needs-review row is in scope for both: approving it promotes it straight
  // into the publish pool, where a missing object is an Instagram failure.
  it('flags a needs-review library row with no stored object', () => {
    const db = memDb()
    seedJob(db, { id: 'j-review', channel: 'chan-a' })
    db.prepare(
      "INSERT INTO library (job_id, video_path, metadata_json, state) VALUES ('j-review', '/nonexistent/final.mp4', '{}', 'needs-review')",
    ).run()
    const digest = buildDigest(db, [], ENV_OK)
    expect(digest).toContain(
      '  job j-review (chan-a) has no stored object — run brainrot library backfill-store',
    )
    db.close()
  })

  // The one excluded state: `library reject` deletes the object on purpose
  // (design spec decision 7), so a blocked row is not missing an upload —
  // reporting it would invite the operator to resurrect what they discarded.
  it('ignores blocked library rows, whose object was deliberately deleted', () => {
    const db = memDb()
    seedJob(db, { id: 'j-blocked', channel: 'chan-a' })
    db.prepare(
      "INSERT INTO library (job_id, video_path, metadata_json, state) VALUES ('j-blocked', '/nonexistent/final.mp4', '{}', 'blocked')",
    ).run()
    const digest = buildDigest(db, [], ENV_OK)
    expect(digest).not.toContain('j-blocked')
    db.close()
  })

  // A row already 'published' on one target can still be eligible for
  // another target (multi-platform publishing) — it still needs an object
  // in the bucket just as much as a plain 'ready' row does.
  it('flags a published library row with no stored object', () => {
    const db = memDb()
    seedJob(db, { id: 'j-published', channel: 'chan-a' })
    db.prepare(
      "INSERT INTO library (job_id, video_path, metadata_json, state) VALUES ('j-published', '/nonexistent/final.mp4', '{}', 'published')",
    ).run()
    const digest = buildDigest(db, [], ENV_OK)
    expect(digest).toContain(
      '  job j-published (chan-a) has no stored object — run brainrot library backfill-store',
    )
    db.close()
  })
})
