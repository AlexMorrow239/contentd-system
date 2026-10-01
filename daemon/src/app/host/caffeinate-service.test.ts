import { execFileSync, spawnSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { tmpDir } from '../../../testing/tmp.js'

const checkout = dirname(fileURLToPath(new URL('../../../../package.json', import.meta.url)))
const entrypoints = [
  ['source', new URL('./caffeinate-service.ts', import.meta.url), true],
  ['test build', new URL('../../../dist/app/host/caffeinate-service.js', import.meta.url), false],
] as const

describe('caffeinate service entrypoint', () => {
  it.each(entrypoints)(
    'resolves the checkout from %s outside its working directory',
    (_, entry, source) => {
      const output = execFileSync(
        process.execPath,
        [
          ...(source ? ['--import', import.meta.resolve('tsx')] : []),
          '--input-type=module',
          '--eval',
          `const { checkoutRoot } = await import(${JSON.stringify(entry.href)}); console.log(checkoutRoot)`,
        ],
        { cwd: tmpDir('caffeinate-cwd-'), encoding: 'utf8', timeout: 10_000 },
      )
      // Importing either entrypoint must not invoke launchctl or start the monitor.
      expect(resolve(output.trim())).toBe(checkout)
    },
  )

  it.each(entrypoints)('executes %s when called as the main script', (_, entry, source) => {
    const result = spawnSync(
      process.execPath,
      [
        ...(source ? ['--import', import.meta.resolve('tsx')] : []),
        fileURLToPath(entry),
        'invalid-mode',
      ],
      { cwd: tmpDir('caffeinate-cwd-'), encoding: 'utf8', timeout: 10_000 },
    )
    expect(result.status).toBe(1)
    expect(result.stderr).toContain(
      process.platform === 'darwin'
        ? 'Usage: pnpm daemon:caffeinate [install|uninstall|run]'
        : 'This helper must run on the macOS host, outside Docker',
    )
  })
})
