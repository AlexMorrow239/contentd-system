import { execa } from 'execa'
import { fileURLToPath } from 'node:url'

/** dist/cli.js — built once per test run by the Vitest globalSetup. */
const CLI_ENTRY = fileURLToPath(new URL('../../dist/cli.js', import.meta.url))

/**
 * Spawn the built CLI: ~0.34s, against ~1.15s for `pnpm exec tsx src/cli.ts`.
 * Never rejects — every call site asserts on exitCode instead.
 *
 * `opts.env` is merged onto the current process's env (execa's default
 * `extendEnv` behavior) rather than replacing it.
 */
export function runCli(args: string[], opts?: { env?: Record<string, string> }) {
  return execa('node', [CLI_ENTRY, ...args], { reject: false, env: opts?.env })
}
