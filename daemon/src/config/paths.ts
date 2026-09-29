import path from 'node:path'

/**
 * Runtime layout shared by the container and disposable test fixtures.
 * Production pins BRAINROT_ROOT in Compose. Host commands must select a root
 * explicitly; development uses tests, not a second operational environment.
 * Keep this module limited to node builtins (enforced by daemon/src/arch.test.ts).
 */
export const ROOT_ENV = 'BRAINROT_ROOT'

export interface BrainrotPaths {
  root: string
  /** SQLite file. `openDb` creates the parent directory. */
  dbPath: string
  /** Parent of `runs/<jobId>/<stage>/`. */
  runsRoot: string
  /** Holds one `<name>.toml` per channel. */
  channelsDir: string
}

/** "" is unset, matching costs.ts. */
export function envValue(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const raw = env[key]
  return raw === undefined || raw.trim() === '' ? undefined : raw
}

/** flag > $BRAINROT_ROOT; no implicit operational state on the host. */
export function resolveRoot(flag?: string, env: NodeJS.ProcessEnv = process.env): string {
  if (flag !== undefined && flag.trim() !== '') return flag
  const root = envValue(env, ROOT_ENV)
  if (root !== undefined) return root
  throw new Error(
    'BRAINROT_ROOT is required (or pass --root). Use docker compose exec brainrot pnpm brainrot for operations; pnpm test for development.',
  )
}

export function resolvePaths(root: string): BrainrotPaths {
  return {
    root,
    // db/ is a subdirectory rather than <root>/brainrot.db so the container's
    // named volume mounts on a DIRECTORY. The alternative would mount the
    // volume at the root itself and nest the runs/channels binds inside it.
    dbPath: path.join(root, 'db', 'brainrot.db'),
    runsRoot: path.join(root, 'runs'),
    channelsDir: path.join(root, 'channels'),
  }
}

/** What every entrypoint actually calls. */
export function resolveBrainrotPaths(
  flag?: string,
  env: NodeJS.ProcessEnv = process.env,
): BrainrotPaths {
  return resolvePaths(resolveRoot(flag, env))
}
