import { describe, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { SLOW_FIRST } from '../../scripts/vitest-sequencer.js'

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url))

/**
 * SLOW_FIRST is a hand-maintained list of repo-relative suffixes matched
 * against absolute module ids. A renamed or deleted test file makes its entry
 * match nothing — the sequencer keeps working, it just silently stops
 * prioritizing that file, which is how the list rotted before (it had lost
 * integrations/remotion/remotion.test.ts, the single slowest file per byte).
 */
describe('SlowFilesFirstSequencer', () => {
  it('lists only test files that still exist', () => {
    const missing = SLOW_FIRST.filter((suffix) => !existsSync(path.join(REPO_ROOT, suffix)))
    expect(missing).toEqual([])
  })

  it('lists each file at most once', () => {
    expect(new Set(SLOW_FIRST).size).toBe(SLOW_FIRST.length)
  })
})
