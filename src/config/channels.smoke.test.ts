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

describe('checked-in channel configs', () => {
  // The maintained directory must contain a valid config; an empty/missing
  // directory must not turn validation into a vacuous pass.
  it('every prod/channels/*.toml loads', () => {
    expect(existsSync(PROD_CHANNELS)).toBe(true)
    const channels = loadChannelsDir(PROD_CHANNELS)
    expect(channels.length).toBeGreaterThan(0)
  })
})
