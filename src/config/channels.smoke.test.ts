import { describe, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadChannelsDir } from './channel.js'

/**
 * Smoke checks against real on-disk channel directories, kept out of
 * channel.test.ts so that file stays entirely hermetic.
 *
 * These assert only that whatever exists still loads — never content, which
 * changes freely. Paths resolve from this module rather than process.cwd() so
 * a single-file run from any directory behaves the same.
 */
const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url))
const PROD_CHANNELS = path.join(REPO_ROOT, 'prod', 'channels')
const LOCAL_CHANNELS = path.join(REPO_ROOT, 'local', 'channels')

describe('checked-in channel configs', () => {
  // prod/channels/test.toml is tracked in git, so every checkout has at
  // least one channel here. Assert on that positively — directory present
  // AND at least one channel actually loaded — rather than only
  // not.toThrow(): loadChannelsDir doesn't throw on a missing/empty
  // directory, so a not.toThrow()-only check would pass vacuously if this
  // path is ever moved again, exactly what happened when channels/ became
  // prod/channels/.
  it('every prod/channels/*.toml loads', () => {
    expect(existsSync(PROD_CHANNELS)).toBe(true)
    const channels = loadChannelsDir(PROD_CHANNELS)
    expect(channels.length).toBeGreaterThan(0)
  })

  /**
   * local/channels/ is the dev mode root's channel directory. It is
   * gitignored, so nothing in CI ever loads it and it can drift out of sync
   * with the schema. A developer who has channels there gets a loud
   * failure; everyone else gets a reported SKIP.
   *
   * skipIf, not an early `return`: a bare return reports a PASS for work that
   * never ran, which is how this check could have gone silently dead.
   */
  it.skipIf(!existsSync(LOCAL_CHANNELS))('local/channels/ loads when present locally', () => {
    expect(() => loadChannelsDir(LOCAL_CHANNELS)).not.toThrow()
  })
})
