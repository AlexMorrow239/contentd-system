import { BrainrotError } from '../errors.js'
import { resolveBrainrotPaths, envValue, type BrainrotPaths } from '../config/paths.js'

export interface DashboardConfig {
  paths: BrainrotPaths
  port: number
}

const DEFAULT_PORT = 8787

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
