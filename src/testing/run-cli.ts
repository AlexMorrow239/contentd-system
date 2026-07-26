import { execa } from 'execa'
import { fileURLToPath } from 'node:url'

/** dist/cli.js — built once per test run by the Vitest globalSetup. */
const CLI_ENTRY = fileURLToPath(new URL('../../dist/cli.js', import.meta.url))

/**
 * Spawn the built CLI: ~0.34s, against ~1.15s for `pnpm exec tsx src/cli.ts`.
 * Never rejects — every call site asserts on exitCode instead.
 *
 * No options parameter on purpose: all 38 existing call sites passed only
 * `reject: false`, and none set cwd or env.
 */
export function runCli(args: string[]) {
  return execa('node', [CLI_ENTRY, ...args], { reject: false })
}
