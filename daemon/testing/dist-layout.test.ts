import { describe, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url))
const DAEMON_ROOT = path.join(REPO_ROOT, 'daemon')
const DIST = path.join(DAEMON_ROOT, 'dist')

// The daemon/dist/ layout is load-bearing, not incidental: three modules resolve
// assets relative to import.meta.url, and they only keep working because
// daemon/dist mirrors daemon/src's directory depth. Bundling flattens that and breaks
// all three. These tests are the guard against a future switch to --bundle.
describe('dist layout (built by the Vitest globalSetup)', () => {
  it('emits the CLI entry that runCli spawns', () => {
    expect(existsSync(path.join(DIST, 'cli.js'))).toBe(true)
  })

  it('places schema.sql where daemon/dist/db/index.js resolves it', () => {
    expect(existsSync(path.join(DIST, 'db', 'schema.sql'))).toBe(true)
  })

  it.each([
    path.join(DAEMON_ROOT, 'src', 'stages', 'assemble.ts'),
    path.join(DIST, 'stages', 'assemble.js'),
  ])('%s points at the real integrations/remotion/index.ts, not a copy', (assemble) => {
    expect(existsSync(assemble)).toBe(true)
    const entry = fileURLToPath(
      new URL('../../../integrations/remotion/index.ts', `file://${assemble}`),
    )
    expect(entry).toBe(path.join(REPO_ROOT, 'integrations', 'remotion', 'index.ts'))
    expect(existsSync(entry)).toBe(true)
  })
})
