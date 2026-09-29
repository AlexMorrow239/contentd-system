import { describe, expect, it } from 'vitest'
import { runCli } from './run-cli.js'

describe('runCli', () => {
  it('runs the built CLI and returns exit 0 with usage on --help', async () => {
    const result = await runCli(['--help'])
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('produce')
  })

  it('returns a nonzero exit instead of rejecting', async () => {
    // Every call site asserts on exitCode, so a throw would break all of them.
    const result = await runCli([
      'produce',
      '--channel',
      '/no/such/channel.toml',
      '--topic',
      'venus',
    ])
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toMatch(/ENOENT|no such file/)
  })
})
