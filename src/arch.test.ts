import { describe, expect, it } from 'vitest'
import { DASHBOARD_STAGE_ORDER } from './dashboard/queries/jobs.js'
import { pipelineStages } from './jobs/pipeline.js'
import { PUBLISH_PLATFORMS } from './publish/types.js'

/**
 * Repo-wide architecture lints: assertions about how modules may depend on
 * each other, rather than about any module's behavior.
 *
 * They live in their own file because they are import-heavy by nature — the
 * thing being guarded is usually "module A must not reach for module B at
 * runtime", which the guard itself can only check by importing B. Kept inside
 * a behavior test file, that cost lands on every run of a file that has no
 * other reason to pay it.
 */
describe('dashboard stage order', () => {
  it('matches the real pipeline order', () => {
    // The dashboard hardcodes the order rather than importing pipelineStages()
    // at runtime — that module pulls in remotion, kokoro and the ffmpeg
    // wrappers, which a read-only viewer has no business loading. This is the
    // anti-drift guard, and it pays the heavy import once, in test only.
    //
    // It was previously inside dashboard/queries/jobs.test.ts, which is
    // otherwise a set of instant in-memory SQL assertions.
    expect([...DASHBOARD_STAGE_ORDER]).toEqual(pipelineStages().map((s) => s.name))
  })
})

describe('publish-next platform agnosticism', () => {
  it('publish-next.ts contains no youtube/instagram string literal in its own source', async () => {
    // The tick drives platforms generically through the adapter registry
    // (src/publish/platforms/index.ts); a platform name appearing in its source
    // means a special case has crept back in.
    //
    // Previously lived inside publish-next.test.ts, which is a behavior file.
    const { readFile } = await import('node:fs/promises')
    const src = await readFile(new URL('./loop/publish-next.ts', import.meta.url), 'utf8')
    for (const platform of PUBLISH_PLATFORMS) {
      expect(src).not.toContain(`'${platform}'`)
      expect(src).not.toContain(`"${platform}"`)
    }
  })
})
