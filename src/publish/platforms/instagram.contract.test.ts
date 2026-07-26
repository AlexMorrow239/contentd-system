import 'dotenv/config'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { openDb } from '../../db/index.js'
import { s3ConfigFromEnv, s3Store } from '../../storage/s3.js'
import { parseTokenKey } from '../crypto.js'
import { publishMedia } from '../media.js'
import { IG_CONTENT_PUBLISH_SCOPE } from '../oauth-flow.js'
import { loadToken, upsertToken } from '../tokens.js'
import { IG_TOKEN_REFRESH_WINDOW_MS, instagramAdapter } from './instagram.js'

// Runs only via `pnpm test:contract` (CONTRACT=1; excluded from default
// `pnpm test` — see vitest.config.ts's CONTRACT split). Posts ONE real
// PRIVATE Reel through the full container-upload flow (design spec §6) to
// the configured Instagram Business account — costs real API quota, never
// run casually. Needs a channel already authorized via
// `pnpm brainrot auth instagram --channel <name>` against the real
// BRAINROT_DB, plus a short real video file on disk (README's Publishing
// (Instagram) section).
const CHANNEL = process.env.CONTRACT_IG_CHANNEL
const IG_USER_ID = process.env.CONTRACT_IG_USER_ID
const VIDEO_PATH = process.env.CONTRACT_IG_VIDEO_PATH

// Uploads CONTRACT_IG_VIDEO_PATH to the configured object store, then posts ONE
// real PRIVATE Reel from a presigned video_url. This is the exact path that
// returned `The parameter video_url is required` before Plan 7, and the only
// thing that validates Meta's real field names.
describe.skipIf(!CHANNEL || !IG_USER_ID || !VIDEO_PATH)('instagram adapter (contract)', () => {
  it('publishes a real Reel from a presigned video_url', async () => {
    const db = openDb(process.env.BRAINROT_DB ?? 'data/brainrot.db')
    const store = s3Store(s3ConfigFromEnv())
    // A `contract/` prefix, never `videos/`: contract objects are not archive
    // material and must not accumulate where backfill-store and the digest
    // sweep would later reason about them.
    const objectKey = `contract/${Date.now()}-reel.mp4`
    try {
      const bytes = readFileSync(VIDEO_PATH!)
      await store.put(objectKey, bytes, 'video/mp4')

      const key = parseTokenKey(process.env.BRAINROT_TOKEN_KEY)
      const adapter = instagramAdapter()
      expect(adapter.hasCredential(db, CHANNEL!, key)).toBe(true)
      const credential = await adapter.resolveCredential(db, CHANNEL!, key, new Date())
      const result = await adapter.upload(
        {
          media: publishMedia({ objectKey, localPath: null, store }),
          meta: {
            title: 'Contract test',
            description: 'Automated contract test — safe to delete.',
            hashtags: [],
          },
          options: { igUserId: IG_USER_ID!, shareToFeed: false },
        },
        credential,
      )
      expect(result.postId).toBeTruthy()
      console.log(
        `contract test posted ${result.postId} (${result.url}) — delete it from Instagram manually`,
      )
    } finally {
      await store.delete(objectKey).catch(() => {})
      db.close()
    }
  }, 180_000)
})

// Exercises resolveCredential's in-place refresh (design spec decision 5)
// against the real Meta Graph API — the fresh-token contract test above
// never enters the refresh branch, so this is the only live coverage of the
// ig_refresh_token renewal path (refreshLongLivedToken). Needs only
// CONTRACT_IG_CHANNEL — unlike the old Facebook Login for Business exchange,
// Instagram Login's refresh needs no app id/secret.
describe.skipIf(!CHANNEL)('instagram token refresh (contract)', () => {
  it('resolveCredential rotates a near-expiry token via the real ig_refresh_token exchange', async () => {
    const db = openDb(process.env.BRAINROT_DB ?? 'data/brainrot.db')
    try {
      const key = parseTokenKey(process.env.BRAINROT_TOKEN_KEY)
      const original = loadToken(db, 'instagram', CHANNEL!, key)
      expect(original).not.toBeNull()

      // Force the stored token inside the refresh window without touching the
      // token bytes themselves, so resolveCredential takes the refresh branch.
      const soonExpiry = new Date(Date.now() + IG_TOKEN_REFRESH_WINDOW_MS - 60_000).toISOString()
      upsertToken(
        db,
        'instagram',
        CHANNEL!,
        original!.token,
        IG_CONTENT_PUBLISH_SCOPE,
        key,
        soonExpiry,
      )

      try {
        const refreshed = await instagramAdapter().resolveCredential(db, CHANNEL!, key, new Date())
        expect(refreshed).toBeTruthy()
        const persisted = loadToken(db, 'instagram', CHANNEL!, key)
        expect(persisted?.expiresAt).not.toBe(soonExpiry)
        expect(new Date(persisted!.expiresAt!).getTime()).toBeGreaterThan(
          Date.now() + IG_TOKEN_REFRESH_WINDOW_MS,
        )
      } catch (err) {
        // Refresh failed against the live API — restore the original
        // expires_at so this run doesn't leave a still-valid token wearing a
        // fake near-expiry timestamp for the next tick to trip over.
        upsertToken(
          db,
          'instagram',
          CHANNEL!,
          original!.token,
          IG_CONTENT_PUBLISH_SCOPE,
          key,
          original!.expiresAt,
        )
        throw err
      }
    } finally {
      db.close()
    }
  }, 30_000)
})
