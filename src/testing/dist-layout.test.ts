import { describe, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url))
const DIST = path.join(REPO_ROOT, 'dist')

// The dist/ layout is load-bearing, not incidental: three modules resolve
// assets relative to import.meta.url, and they only keep working because
// dist/ mirrors src/'s directory depth. Bundling flattens that and breaks
// all three. These tests are the guard against a future switch to --bundle.
describe('dist layout (built by the Vitest globalSetup)', () => {
  it('emits the CLI entry that runCli spawns', () => {
    expect(existsSync(path.join(DIST, 'cli.js'))).toBe(true)
  })

  it('places schema.sql where dist/db/index.js resolves it', () => {
    expect(existsSync(path.join(DIST, 'db', 'schema.sql'))).toBe(true)
  })

  it('keeps assemble.js pointing at the real remotion/index.ts, not a copy', () => {
    const assemble = path.join(DIST, 'stages', 'assemble.js')
    expect(existsSync(assemble)).toBe(true)
    // assemble.ts computes: new URL('../../remotion/index.ts', import.meta.url)
    const entry = fileURLToPath(new URL('../../remotion/index.ts', `file://${assemble}`))
    expect(entry).toBe(path.join(REPO_ROOT, 'remotion', 'index.ts'))
    expect(existsSync(entry)).toBe(true)
  })
})
