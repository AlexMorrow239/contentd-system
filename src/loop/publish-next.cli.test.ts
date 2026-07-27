import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { runCli } from '../testing/run-cli.js'
import { writeChannel } from './_publish-next.fixtures.js'
import { tmpDir } from '../testing/tmp.js'

/**
 * The `publish-next` CLI surface, spawned as a subprocess.
 *
 * Split from a single 1825-line publish-next.test.ts — the largest file in the
 * repo — whose eleven fixtures sat in a 300-line preamble. They now live in
 * _publish-next.fixtures.ts.
 */

describe('publish-next CLI', () => {
  it.concurrent(
    '`publish-next --help` prints usage with --db/--channels-dir/--dry-run/--force',
    async () => {
      const result = await runCli(['publish-next', '--help'])
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain('--db')
      expect(result.stdout).toContain('--channels-dir')
      expect(result.stdout).toContain('--dry-run')
      expect(result.stdout).toContain('--force')
    },
    60000,
  )

  it.concurrent(
    '`publish-next` with no publishing channel prints one noop JSON line and exits 0',
    async () => {
      const root = tmpDir('brainrot-publish-cli-')
      const channelsDir = tmpDir('brainrot-publish-cli-channels-')
      writeChannel(channelsDir, { name: 'chan-a' })
      const result = await runCli([
        'publish-next',
        '--db',
        join(root, 'brainrot.db'),
        '--channels-dir',
        channelsDir,
      ])
      expect(result.exitCode).toBe(0)
      expect(result.stdout.trim().split('\n')).toHaveLength(1)
      expect(JSON.parse(result.stdout)).toEqual({ action: 'noop', reason: 'no-publish-channel' })
    },
    60000,
  )

  it.concurrent(
    '`publish-next --dry-run` with no publishing channel prints one dry-run JSON line and exits 0',
    async () => {
      const root = tmpDir('brainrot-publish-cli-dry-')
      const channelsDir = tmpDir('brainrot-publish-cli-dry-channels-')
      writeChannel(channelsDir, { name: 'chan-a' })
      const result = await runCli([
        'publish-next',
        '--db',
        join(root, 'brainrot.db'),
        '--channels-dir',
        channelsDir,
        '--dry-run',
      ])
      expect(result.exitCode).toBe(0)
      expect(result.stdout.trim().split('\n')).toHaveLength(1)
      expect(JSON.parse(result.stdout)).toEqual({
        action: 'dry-run',
        wouldPublish: null,
        reason: 'no-publish-channel',
      })
    },
    60000,
  )
})
