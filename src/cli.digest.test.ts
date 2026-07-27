import { describe, expect, it } from 'vitest'
import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { runCli } from './testing/run-cli.js'
import { tmpDir } from './testing/tmp.js'
import { tmpDbPath } from './testing/cli.js'

/**
 * Covers `digest`, including its two config-error paths.
 *
 * Split out of a single 742-line cli.test.ts that held 28 subprocess tests in
 * one describe alongside four pure-function suites. Beyond readability this is
 * a scheduling win: `it.concurrent` batches at maxConcurrency within ONE file,
 * so 28 spawns queued 8 at a time in a single worker; separate files spread
 * across workers instead.
 */
describe('brainrot CLI — digest', () => {
  it.concurrent(
    '`digest --help` prints usage with --db/--channels-dir',
    async () => {
      const result = await runCli(['digest', '--help'])
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain('--db')
      expect(result.stdout).toContain('--channels-dir')
    },
    60000,
  )

  it.concurrent(
    '`digest` over an empty channels dir prints all four sections and exits 0',
    async () => {
      const dbPath = tmpDbPath()
      const channelsDir = tmpDir('brainrot-digest-channels-')
      const result = await runCli(['digest', '--db', dbPath, '--channels-dir', channelsDir])
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain('Topics (last 24h)')
      expect(result.stdout).toContain('Jobs (last 24h)')
      expect(result.stdout).toContain('Spend today (UTC)')
      expect(result.stdout).toContain('Action items')
    },
    60000,
  )

  // A channels dir that will not load used to cost the operator the whole
  // report — one stderr line and nothing else, on the morning it matters most.
  it.concurrent(
    '`digest` with a missing channels dir still prints the db sections and names the config error',
    async () => {
      const dbPath = tmpDbPath()
      const result = await runCli([
        'digest',
        '--db',
        dbPath,
        '--channels-dir',
        '/no/such/channels-dir',
      ])
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain('Topics (last 24h)')
      expect(result.stdout).toContain('Jobs (last 24h)')
      expect(result.stdout).toContain('Action items')
      expect(result.stdout).toContain('the channels dir did not load')
      expect(result.stdout).toMatch(/ENOENT|no such/)
    },
    60000,
  )

  it.concurrent(
    '`digest` with an unparseable channel TOML still prints the db sections and names the file',
    async () => {
      const dbPath = tmpDbPath()
      const channelsDir = tmpDir('brainrot-digest-broken-')
      writeFileSync(path.join(channelsDir, 'broken.toml'), 'this is not toml [')
      const result = await runCli(['digest', '--db', dbPath, '--channels-dir', channelsDir])
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain('Topics (last 24h)')
      expect(result.stdout).toContain('Jobs (last 24h)')
      expect(result.stdout).toContain('the channels dir did not load')
      expect(result.stdout).toContain('broken.toml')
    },
    60000,
  )
})
