import path from 'node:path'

/**
 * The one definition of where state lives.
 *
 * There are exactly two modes of operation — the containerized daemon (its
 * SQLite volume, its dashboard, the sidecar it depends on) and local
 * development driven by the manual CLI triggers — and each gets one canonical
 * root directory holding everything it owns. Before this module the split was
 * three independent environment variables whose CODE DEFAULTS were the
 * production paths, so any process that started without the host `.env`
 * targeted production by omission (which happened: a stray host-side
 * `data/brainrot.db` that nothing read), and "dev db + prod runs" was a
 * reachable state.
 *
 * Imports are limited to `node:` builtins, enforced by an arch lint in
 * src/arch.test.ts: every entrypoint reaches this module, so a dependency
 * added here becomes a dependency everywhere.
 */

export const ROOT_ENV = 'BRAINROT_ROOT'

/**
 * Unset means DEVELOPMENT. This inversion is the point of the module: the old
 * defaults were `data/brainrot.db`/`runs`/`channels`, so forgetting to set
 * anything aimed at production. The container never relies on this — compose
 * pins BRAINROT_ROOT explicitly.
 */
export const DEFAULT_ROOT = 'local'

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

/** flag > $BRAINROT_ROOT > DEFAULT_ROOT. */
export function resolveRoot(flag?: string, env: NodeJS.ProcessEnv = process.env): string {
  if (flag !== undefined && flag.trim() !== '') return flag
  return envValue(env, ROOT_ENV) ?? DEFAULT_ROOT
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
