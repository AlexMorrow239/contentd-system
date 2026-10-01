import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { tmpDir } from './tmp.js'

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

  it('places schema.sql where daemon/dist/infra/db/index.js resolves it', () => {
    expect(existsSync(path.join(DIST, 'infra', 'db', 'schema.sql'))).toBe(true)
  })

  it.each([
    ['source', new URL('../src/infra/db/index.ts', import.meta.url), true],
    ['test build', new URL('../dist/infra/db/index.js', import.meta.url), false],
  ] as const)('opens the database from %s outside the checkout', (_, entry, source) => {
    const output = execFileSync(
      process.execPath,
      [
        ...(source ? ['--import', import.meta.resolve('tsx')] : []),
        '--input-type=module',
        '--eval',
        `const { openDb } = await import(${JSON.stringify(entry.href)});
         const db = openDb('./state/contentd.db');
         console.log(db.prepare('SELECT count(*) AS count FROM jobs').get().count);
         db.close();`,
      ],
      { cwd: tmpDir('database-cwd-'), encoding: 'utf8', timeout: 10_000 },
    )
    expect(output.trim()).toBe('0')
  })

  it.each([
    path.join(DAEMON_ROOT, 'src', 'features', 'production', 'stages', 'assemble.ts'),
    path.join(DIST, 'features', 'production', 'stages', 'assemble.js'),
  ])('%s points at the real integrations/remotion/index.ts, not a copy', (assemble) => {
    expect(existsSync(assemble)).toBe(true)
    const entry = fileURLToPath(
      new URL('../../../../../integrations/remotion/index.ts', `file://${assemble}`),
    )
    expect(entry).toBe(path.join(REPO_ROOT, 'integrations', 'remotion', 'index.ts'))
    expect(existsSync(entry)).toBe(true)
  })
})
