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
const CHANNELS = path.join(REPO_ROOT, 'channels')
const CHANNELS_DEV = path.join(REPO_ROOT, 'channels-dev')

describe('checked-in channel configs', () => {
  it('every channels/*.toml loads', () => {
    expect(() => loadChannelsDir(CHANNELS)).not.toThrow()
  })

  /**
   * channels-dev/ is gitignored (it predates local/channels/, the dev mode
   * root's channel directory), so nothing in CI ever loads it and it can
   * drift out of sync with the schema. A developer who has it gets a loud
   * failure; everyone else gets a reported SKIP.
   *
   * skipIf, not an early `return`: a bare return reports a PASS for work that
   * never ran, which is how this check could have gone silently dead.
   */
  it.skipIf(!existsSync(CHANNELS_DEV))('channels-dev/ loads when present locally', () => {
    expect(() => loadChannelsDir(CHANNELS_DEV)).not.toThrow()
  })
})
