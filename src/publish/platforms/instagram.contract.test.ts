import 'dotenv/config'
import { describe, expect, it } from 'vitest'
import { openDb } from '../../db/index.js'
import { parseTokenKey } from '../crypto.js'
import { instagramAdapter } from './instagram.js'

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

// describe.skipIf (not a thrown error) is what lets `CONTRACT=1 pnpm test`
// exit 0 when these three are unset, instead of failing or hanging.
describe.skipIf(!CHANNEL || !IG_USER_ID || !VIDEO_PATH)('instagram adapter (contract)', () => {
  it('publishes a real Reel through the full container flow', async () => {
    const db = openDb(process.env.BRAINROT_DB ?? 'data/brainrot.db')
    try {
      const key = parseTokenKey(process.env.BRAINROT_TOKEN_KEY)
      const adapter = instagramAdapter()
      expect(adapter.hasCredential(db, CHANNEL!, key)).toBe(true)
      const credential = await adapter.resolveCredential(db, CHANNEL!, key, new Date())
      const result = await adapter.upload(
        {
          videoPath: VIDEO_PATH!,
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
      db.close()
    }
  }, 120_000)
})
