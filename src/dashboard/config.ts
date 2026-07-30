import { BrainrotError } from '../errors.js'
import { resolveBrainrotPaths, type BrainrotPaths } from '../config/paths.js'

export interface DashboardConfig {
  paths: BrainrotPaths
  port: number
}

const DEFAULT_PORT = 8787

// Empty string means unset, matching costs.ts (BRAINROT_GLOBAL_DAILY_USD) and
// youtube.ts (BRAINROT_YT_UPLOADS_PER_DAY): docker-compose.yml pins some keys
// to "" deliberately, and "" must never be read as a real value.
function envValue(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const raw = env[key]
  return raw === undefined || raw.trim() === '' ? undefined : raw
}

/**
 * One root per process, exactly like every other entrypoint. There is no
 * prod/dev switch anymore: `?db=dev` was already dead in the container (the dev
 * file lived on the host, outside the named volume) and a single process
 * reading both modes is the cross-mode coupling this design removes. To view
 * development state, run a second dashboard with BRAINROT_ROOT=local.
 */
export function resolveDashboardConfig(env: NodeJS.ProcessEnv = process.env): DashboardConfig {
  const rawPort = envValue(env, 'BRAINROT_DASHBOARD_PORT')
  let port = DEFAULT_PORT
  if (rawPort !== undefined) {
    const parsed = Number(rawPort)
    if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65535) {
      throw new BrainrotError(
        `invalid BRAINROT_DASHBOARD_PORT: ${JSON.stringify(rawPort)} (expected a port 1-65535)`,
        { domain: 'config', kind: 'invalid' },
      )
    }
    port = parsed
  }
  return { paths: resolveBrainrotPaths(undefined, env), port }
}
