import type { Database } from 'better-sqlite3'
import type { ContentdPaths } from '../../config/paths.js'
import { resolveContentdPaths } from '../../config/paths.js'
import { openDb } from '../../infra/db/index.js'

// Production pins the root in Compose; test subprocesses supply a temp root.
export const ROOT_OPTION_DESC =
  'runtime root holding db/, runs/ and channels/ (required: flag or $CONTENTD_ROOT)'

/**
 * The one resolve → open → work → close sequence every db-touching command
 * runs. Half of them used to leak the handle (no close at all) and the other
 * half spelled the try/finally out again; both are this wrapper's job now.
 *
 * The finally is guarded rather than unconditional because `produce` closes
 * mid-action on purpose (see its comment) — a command may hand the handle
 * back already closed, and that must not be a double-close error.
 *
 * A command whose work must precede the db handle — `scout` loads its
 * channels first, deliberately — resolves paths itself and calls this after.
 */
export async function withDb<T>(
  opts: { root?: string },
  fn: (db: Database, paths: ContentdPaths) => T | Promise<T>,
): Promise<T> {
  const paths = resolveContentdPaths(opts.root)
  const db = openDb(paths.dbPath)
  try {
    return await fn(db, paths)
  } finally {
    if (db.open) db.close()
  }
}

/** The one-JSON-line stdout contract every cron-facing command keeps. */
export function printJson(value: unknown): void {
  process.stdout.write(JSON.stringify(value) + '\n')
}

/**
 * Prints the human-readable cause of a tick that could not run at all, on
 * stderr, beside the JSON line stdout gets — an operator grepping only for
 * `action` would otherwise see a bare `config-error` and no file name.
 *
 * This lives at the ONE-SHOT CLI, not inside the tick functions, and that is
 * the whole point: the same ticks now run under `contentd run` every 30
 * seconds, where an unstructured print bypasses runWorker's idle dedupe and
 * turns one bad channel TOML into 2,880 stderr lines a day. The daemon
 * reports these through the deduped `{"action":"noop","reason":...}` line
 * instead; a one-shot invocation has a human reading its stderr right now.
 */
export function reportBlockedTick(
  command: string,
  result: { action: string; reason?: string; error?: string },
): void {
  if (result.action !== 'noop') return
  if (result.reason !== 'config-error') return
  if (result.error !== undefined) console.error(`${command}: ${result.error}`)
}
