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
 *   src/stages/assemble.ts   ../../integrations/remotion/...  -> <repo>/integrations/remotion/index.ts
 *
 * The last is why outbase matters: dist/stages/assemble.js walking ../../
 * lands on the repo root, so Remotion bundles from real source, not a copy.
 */
import { build } from 'esbuild'
import { copyFileSync, readdirSync, rmSync, statSync } from 'node:fs'
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

/** Every emitted file, as a dist-relative path. */
function expectedOutputs(sources: string[]): Set<string> {
  const out = new Set(sources.map((f) => path.relative(SRC, f).replace(/\.ts$/, '.js')))
  out.add(path.join('db', 'schema.sql')) // copied below, not emitted
  return out
}

/**
 * Deletes dist/ files that no longer correspond to anything under src/.
 *
 * A blanket rmSync(DIST) is not an option — it would race any subprocess
 * already spawned from the tree — but leaving deletions behind forever means a
 * module renamed in src/ keeps a stale twin in dist/ that still imports and
 * still runs. Removing only the orphans is safe: nothing current can be
 * executing a file that no longer has a source.
 */
function pruneOrphans(expected: Set<string>, dir: string = DIST): void {
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return // first run: dist/ does not exist yet
  }
  for (const name of entries) {
    const full = path.join(dir, name)
    if (statSync(full).isDirectory()) {
      pruneOrphans(expected, full)
      if (readdirSync(full).length === 0) rmSync(full, { recursive: true, force: true })
    } else if (!expected.has(path.relative(DIST, full))) {
      rmSync(full, { force: true })
    }
  }
}

export async function buildTestCli(): Promise<void> {
  // Deliberately no rmSync(DIST): esbuild overwrites in place, and clearing the
  // tree would race any already-running subprocess spawned from it. Orphans
  // are pruned individually below instead.
  const sources = entryPoints()
  await build({
    entryPoints: sources,
    outbase: SRC,
    outdir: DIST,
    platform: 'node',
    format: 'esm',
    target: 'node22',
  })
  // db/index.ts reads this via import.meta.url; esbuild only emits JS.
  copyFileSync(path.join(SRC, 'db', 'schema.sql'), path.join(DIST, 'db', 'schema.sql'))
  pruneOrphans(expectedOutputs(sources))
}
