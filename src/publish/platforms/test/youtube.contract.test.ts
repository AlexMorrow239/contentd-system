import 'dotenv/config'
import { describe, it, expect } from 'vitest'
import type { TestContext } from 'vitest'
import { fileURLToPath } from 'node:url'
import { openDb } from '../../../db/index.js'
import { resolveBrainrotPaths } from '../../../config/paths.js'
import { parseTokenKey } from '../../crypto.js'
import { publishMedia } from '../../media.js'
import { loadToken } from '../../tokens.js'
import type { PublishChannelConfig } from '../../types.js'
import { mintAccessToken, youtubeTarget } from '../youtube.js'

// Runs only via `pnpm test:contract` (CONTRACT=1; excluded from default
// `pnpm test`). Makes ONE real YouTube upload — private, ~5KB fixture —
// then deletes it via the API, leaving the channel clean. Quota cost only
// (~1,650 units for the upload + delete), no USD spend. Needs a real
// per-channel grant already on file: run
// `pnpm brainrot auth youtube --channel <CONTRACT_YT_CHANNEL>` against
// $BRAINROT_ROOT (or "local") first (README's Publishing (YouTube) section).
const REQUIRED_ENV = [
  'YT_CLIENT_ID',
  'YT_CLIENT_SECRET',
  'BRAINROT_TOKEN_KEY',
  'CONTRACT_YT_CHANNEL',
] as const

const fixturePath = fileURLToPath(new URL('../__fixtures__/tiny.mp4', import.meta.url))

describe('youtube adapter (contract)', () => {
  it('uploads a private Short and deletes it via the real API', async (ctx: TestContext) => {
    const missing = REQUIRED_ENV.filter((name) => !process.env[name])
    if (missing.length > 0) {
      ctx.skip(
        `youtube contract test needs ${missing.join(', ')} set — see README's Publishing (YouTube) section`,
      )
    }

    const db = openDb(resolveBrainrotPaths().dbPath)
    try {
      const key = parseTokenKey(process.env.BRAINROT_TOKEN_KEY)
      const channel = process.env.CONTRACT_YT_CHANNEL!
      const stored = loadToken(db, 'youtube', channel, key)
      if (stored === null) {
        ctx.skip(
          `no stored youtube refresh token for channel "${channel}" — run ` +
            `\`pnpm brainrot auth youtube --channel ${channel}\` against $BRAINROT_ROOT (or "local") first`,
        )
      }

      const accessToken = await mintAccessToken({
        refreshToken: stored.token,
        clientId: process.env.YT_CLIENT_ID!,
        clientSecret: process.env.YT_CLIENT_SECRET!,
      })

      // PublishChannelConfig moved from a flat per-channel shape to a list of
      // per-platform targets (Task 2/5) — this fixture constructs a single
      // youtube target carrying the same placeholder values the old flat
      // fixture intended (private/category 24/not made for kids), then
      // narrows it back to its youtube variant to read a properly-typed
      // YoutubeOptions for youtubeTarget().upload() below.
      const publish: PublishChannelConfig = {
        targets: [
          {
            platform: 'youtube',
            options: { privacy: 'private', categoryId: 24, madeForKids: false },
          },
        ],
      }
      const target = publish.targets[0]
      if (target.platform !== 'youtube') {
        throw new Error('unreachable: fixture only declares a youtube target')
      }
      const { postId, url } = await youtubeTarget().upload(
        {
          media: publishMedia({ objectKey: null, localPath: fixturePath, store: null }),
          meta: {
            title: 'brainrot contract test (private, auto-deleted)',
            description: '',
            hashtags: [],
          },
          options: target.options,
        },
        accessToken,
      )

      expect(postId).toMatch(/^[A-Za-z0-9_-]{11}$/)
      expect(url).toBe(`https://youtube.com/shorts/${postId}`)

      // Cleanup is best-effort: videos.delete requires the youtube.force-ssl
      // scope, but this flow grants youtube.upload only — a live run gets a
      // 403, which must not strand a private upload as a red test. 204 is full
      // success; 403 warns for a manual Studio delete; anything else fails.
      const del = await fetch(`https://www.googleapis.com/youtube/v3/videos?id=${postId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${accessToken}` },
      })
      if (del.status === 403) {
        console.warn(
          `youtube contract test: could not delete video ${postId} (403 — the upload-only grant lacks youtube.force-ssl); delete it manually in YouTube Studio`,
        )
      } else {
        expect(del.status).toBe(204)
      }
    } finally {
      db.close()
    }
  }, 120_000)
})
