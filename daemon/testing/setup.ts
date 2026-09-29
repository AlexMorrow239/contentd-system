import { afterAll, afterEach, vi } from 'vitest'
import { sweep } from './tmp.js'

/**
 * Registered as `setupFiles` in vitest.config.ts, so this runs once per test
 * FILE, before that file's own hooks. It holds the two teardown rules that
 * every test file needs and that were previously hand-written (or forgotten)
 * per file.
 */

/**
 * Was duplicated verbatim in fourteen files. Safe to hoist: no test file stubs
 * env in `beforeAll`, so nothing depends on a stub surviving between tests.
 * Files may still call vi.unstubAllEnvs() themselves — it is idempotent.
 */
afterEach(() => {
  vi.unstubAllEnvs()
})

/**
 * Drains ./tmp.ts's registries. afterAll rather than afterEach because temp
 * dirs are routinely created in `beforeAll` and shared across a file's tests
 * (the ffmpeg fixture hoists in qc/visuals-volume depend on this).
 */
afterAll(() => {
  sweep()
})
