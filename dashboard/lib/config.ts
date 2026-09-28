import { BrainrotError } from '../../src/errors.js'
import { resolveBrainrotPaths, envValue, type BrainrotPaths } from '../../src/config/paths.js'

export interface DashboardConfig {
  paths: BrainrotPaths
  port: number
  host: string
}

const DEFAULT_PORT = 8787
const DEFAULT_HOST = '127.0.0.1'

/** The dashboard uses the same explicit runtime root as the CLI. */
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
  return {
    paths: resolveBrainrotPaths(undefined, env),
    port,
    host: envValue(env, 'BRAINROT_DASHBOARD_HOST') ?? DEFAULT_HOST,
  }
}
