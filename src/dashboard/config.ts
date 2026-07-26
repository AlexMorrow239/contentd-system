export type DbChoice = 'prod' | 'dev'

export interface DashboardConfig {
  dbPaths: Record<DbChoice, string>
  runsRoot: string
  channelsDir: string
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

export function resolveDashboardConfig(env: NodeJS.ProcessEnv = process.env): DashboardConfig {
  const rawPort = envValue(env, 'BRAINROT_DASHBOARD_PORT')
  let port = DEFAULT_PORT
  if (rawPort !== undefined) {
    const parsed = Number(rawPort)
    if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65535) {
      throw new Error(
        `invalid BRAINROT_DASHBOARD_PORT: ${JSON.stringify(rawPort)} (expected a port 1-65535)`,
      )
    }
    port = parsed
  }
  return {
    dbPaths: {
      // Same defaults as the CLI's resolveDbPath/resolveRunsRoot/resolveChannelsDir,
      // so the dashboard inside the container sees exactly what the loops see.
      prod: envValue(env, 'BRAINROT_DB') ?? 'data/brainrot.db',
      dev: envValue(env, 'BRAINROT_DEV_DB') ?? 'data/dev.db',
    },
    runsRoot: envValue(env, 'BRAINROT_RUNS_ROOT') ?? 'runs',
    channelsDir: envValue(env, 'BRAINROT_CHANNELS_DIR') ?? 'channels',
    port,
  }
}

export function resolveDbChoice(raw: string | undefined): DbChoice {
  return raw === 'dev' ? 'dev' : 'prod'
}
