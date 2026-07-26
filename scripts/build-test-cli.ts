/**
 * Builds src/ into dist/ so the CLI subprocess tests can spawn
 * `node dist/cli.js` (~0.34s) instead of `pnpm exec tsx src/cli.ts` (~1.15s).
 * Invoked once per test run from the Vitest globalSetup — production code
 * never calls this, and `pnpm build` remains the type-checking entry point
 * (esbuild only transpiles; it does not type-check).
 *
 * Transpile-only, NOT --bundle. Bundling flattens the module graph and breaks
 * every import.meta.url-relative asset lookup. The three references in this
 * codebase all survive the mirrored layout that `outbase: SRC` produces:
 *
 *   src/cli.ts:576           main-module guard   -> dist/cli.js vs process.argv[1]
 *   src/db/index.ts:7        ./schema.sql        -> dist/db/schema.sql (copied below)
 *   src/stages/assemble.ts   ../../remotion/...  -> <repo>/remotion/index.ts
 *
 * The last is why outbase matters: dist/stages/assemble.js walking ../../
 * lands on the repo root, so Remotion bundles from real source, not a copy.
 */
import { build } from 'esbuild'
import { copyFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))
const SRC = path.join(REPO_ROOT, 'src')
const DIST = path.join(REPO_ROOT, 'dist')

/** Every .ts under src/ except tests and the test-only helpers in src/testing/. */
function entryPoints(dir: string = SRC, acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name)
    if (statSync(full).isDirectory()) {
      if (full !== path.join(SRC, 'testing')) entryPoints(full, acc)
    } else if (name.endsWith('.ts') && !name.endsWith('.test.ts')) {
      acc.push(full)
    }
  }
  return acc
}

export async function buildTestCli(): Promise<void> {
  // Deliberately no rmSync(DIST): esbuild overwrites in place, and clearing the
  // tree would race any already-running subprocess spawned from it.
  await build({
    entryPoints: entryPoints(),
    outbase: SRC,
    outdir: DIST,
    platform: 'node',
    format: 'esm',
    target: 'node22',
  })
  // db/index.ts reads this via import.meta.url; esbuild only emits JS.
  copyFileSync(path.join(SRC, 'db', 'schema.sql'), path.join(DIST, 'db', 'schema.sql'))
}
