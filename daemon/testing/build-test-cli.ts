/**
 * Builds daemon/src/ into daemon/dist/ so the CLI subprocess tests can spawn
 * `node daemon/dist/cli.js` instead of `pnpm exec tsx daemon/src/cli.ts`.
 * Invoked once per test run from the Vitest globalSetup — production code
 * never calls this, and `pnpm build` remains the type-checking entry point
 * (esbuild only transpiles; it does not type-check).
 *
 * Transpile-only, NOT --bundle. Bundling flattens the module graph and breaks
 * every import.meta.url-relative asset lookup. The three references in this
 * codebase all survive the mirrored layout that `outbase: SRC` produces:
 *
 *   daemon/src/cli.ts               main-module guard   -> daemon/dist/cli.js vs process.argv[1]
 *   daemon/src/infra/db/index.ts          ./schema.sql        -> daemon/dist/infra/db/schema.sql (copied below)
 *   daemon/src/features/production/stages/assemble.ts   ../../../../../integrations/remotion/...  -> <repo>/integrations/remotion/index.ts
 *
 * The last is why outbase matters: daemon/dist/features/production/stages/assemble.js walking ../../../../../
 * lands on the repo root, so Remotion bundles from real source, not a copy.
 */
import { build } from 'esbuild'
import { copyFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url))
const SRC = path.join(REPO_ROOT, 'daemon', 'src')
const DIST = path.join(REPO_ROOT, 'daemon', 'dist')
// infra/db/index.ts reads this via import.meta.url; esbuild only emits JS.
const SCHEMA = path.join('infra', 'db', 'schema.sql')

/** Every non-test .ts module under daemon/src/. */
function entryPoints(dir: string = SRC, acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name)
    if (statSync(full).isDirectory()) {
      entryPoints(full, acc)
    } else if (name.endsWith('.ts') && !name.endsWith('.test.ts')) {
      acc.push(full)
    }
  }
  return acc
}

/** Every emitted file, as a dist-relative path. */
function expectedOutputs(sources: string[]): Set<string> {
  const out = new Set(sources.map((f) => path.relative(SRC, f).replace(/\.ts$/, '.js')))
  out.add(SCHEMA) // copied below, not emitted
  return out
}

/**
 * Deletes daemon/dist/ files that no longer correspond to anything under daemon/src/.
 *
 * A blanket rmSync(DIST) is not an option — it would race any subprocess
 * already spawned from the tree — but leaving deletions behind forever means a
 * module renamed in daemon/src/ keeps a stale twin in daemon/dist/ that still imports and
 * still runs. Removing only the orphans is safe: nothing current can be
 * executing a file that no longer has a source.
 */
function pruneOrphans(expected: Set<string>, dir: string = DIST): void {
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return // first run: daemon/dist/ does not exist yet
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
  copyFileSync(path.join(SRC, SCHEMA), path.join(DIST, SCHEMA))
  pruneOrphans(expectedOutputs(sources))
}
