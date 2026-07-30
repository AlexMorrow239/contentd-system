import path from 'node:path'
import { BrainrotError } from '../errors.js'

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
 * Imports are limited to `node:` builtins and ../errors.js, enforced by an
 * arch lint in src/arch.test.ts: every entrypoint reaches this module, so a
 * dependency added here becomes a dependency everywhere.
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

/**
 * Removed variable -> what replaced it. Kept as data so the error message and
 * the test that pins it read from the same source.
 */
const REMOVED_PATH_ENV: Record<string, string> = {
  BRAINROT_DB: 'the database is now <root>/db/brainrot.db',
  BRAINROT_RUNS_ROOT: 'run artifacts are now <root>/runs',
  BRAINROT_CHANNELS_DIR: 'channel TOMLs are now <root>/channels',
  BRAINROT_DEV_DB:
    'the dashboard serves one root; run a second dashboard with BRAINROT_ROOT=local to view development state',
}

/** "" is unset, matching dashboard/config.ts's envValue and costs.ts. */
function envValue(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const raw = env[key]
  return raw === undefined || raw.trim() === '' ? undefined : raw
}

/**
 * Throws if any removed path variable is still set.
 *
 * Deliberately an error rather than a silent ignore, and deliberately checked
 * even when a --root flag was passed. A leftover `BRAINROT_DB=data/dev.db` that
 * were merely ignored would send a dev command into whatever root the default
 * picked — the exact class of bug this module exists to remove. Same treatment
 * a stale `slots`/`min_score` key gets in src/config/channel.ts.
 *
 * Consequence worth knowing: docker-compose's `env_file` forwards the whole
 * host .env into the container, so a .env still carrying one of these keys
 * fails the daemon at startup instead of being shadowed by the `environment:`
 * pin. That is intended — a variable that is fatal on the host and inert in the
 * container would be worse.
 */
export function assertNoLegacyPathEnv(env: NodeJS.ProcessEnv = process.env): void {
  for (const [key, replacement] of Object.entries(REMOVED_PATH_ENV)) {
    if (envValue(env, key) === undefined) continue
    throw new BrainrotError(
      `${key} is no longer read (removed in favor of ${ROOT_ENV}): ${replacement}. ` +
        `Set ${ROOT_ENV} to the mode root instead — "${DEFAULT_ROOT}" for development, ` +
        `"/app/state" in the container — and remove ${key} from your .env.`,
      { domain: 'config', kind: 'invalid' },
    )
  }
}

/** flag > $BRAINROT_ROOT > DEFAULT_ROOT. */
export function resolveRoot(flag?: string, env: NodeJS.ProcessEnv = process.env): string {
  assertNoLegacyPathEnv(env)
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
