import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { Database } from 'better-sqlite3'
import { resolvePaths, type BrainrotPaths } from '../src/config/paths.js'

/**
 * Temp dirs and db handles created by a test file, drained by setup.ts's
 * afterAll. This replaces the `const cleanup: string[]` + local `tmp()` +
 * `afterAll(rmSync...)` block that was copy-pasted into nine test files —
 * and, more importantly, the thirteen files that mkdtemp'd and never cleaned
 * up at all. On macOS those land in /var/folders and are not auto-reaped, so
 * they accumulated across every run.
 *
 * Module state is per test file: vitest isolates the module graph per file, so
 * one file's registry can never drain another's.
 */
const dirs: string[] = []
const handles: Database[] = []

/** A temp dir removed after the current test FILE finishes. */
export function tmpDir(prefix = 'brainrot-'): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

/**
 * A disposable runtime root with db/, runs/ and channels/ already created, laid out by
 * the SAME resolvePaths the CLI uses — so a test can never assert against a
 * layout production does not have. Removed after the current test FILE
 * finishes, like every other tmpDir.
 */
export function testRoot(prefix = 'brainrot-root-'): BrainrotPaths {
  const paths = resolvePaths(tmpDir(prefix))
  for (const dir of [path.dirname(paths.dbPath), paths.runsRoot, paths.channelsDir]) {
    mkdirSync(dir, { recursive: true })
  }
  return paths
}

/**
 * Register an already-open db so it is closed after the file finishes.
 * `memDb`/`fileDb` in ./db.ts call this for you; it is exported for the few
 * places that open a handle by hand.
 */
export function trackDb(db: Database): Database {
  handles.push(db)
  return db
}

/** Drains both registries. Called by ./setup.ts — tests should not call it. */
export function sweep(): void {
  for (const db of handles.splice(0)) {
    // A test that already closed its own handle is normal, not an error.
    try {
      db.close()
    } catch {
      // already closed
    }
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
}
