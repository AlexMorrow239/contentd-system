import { ContentdError } from '../shared/errors.js'

export const DEFAULT_GLOBAL_DAILY_USD = 25

function invalid(message: string): never {
  throw new ContentdError(message, { domain: 'config', kind: 'invalid' })
}

/** Read at call time so every entrypoint uses the same environment setting. */
export function globalDailyCapMicros(): number {
  const raw = process.env.CONTENTD_GLOBAL_DAILY_USD
  const usd = raw === undefined || raw.trim() === '' ? DEFAULT_GLOBAL_DAILY_USD : Number(raw)
  const micros = Math.round(usd * 1_000_000)
  if (
    !Number.isFinite(usd) ||
    usd < 0 ||
    !Number.isSafeInteger(micros) ||
    (usd > 0 && micros === 0)
  ) {
    invalid(
      `invalid CONTENTD_GLOBAL_DAILY_USD: ${JSON.stringify(raw)} (expected non-negative USD representable in integer micros)`,
    )
  }
  return micros
}

/** An omitted channel cap leaves only the global cap. Never silently clamp it. */
export function validateChannelBudget(
  name: string,
  cap: number | undefined,
  global = globalDailyCapMicros(),
): void {
  if (cap === undefined) return
  if (!Number.isSafeInteger(cap) || cap <= 0) {
    invalid(
      `channel "${name}": [budget] per_day_usd must be positive and representable in integer micros`,
    )
  }
  if (cap >= global) {
    invalid(
      `channel "${name}": [budget] per_day_usd ($${cap / 1_000_000}) must be lower than CONTENTD_GLOBAL_DAILY_USD ($${global / 1_000_000})`,
    )
  }
}
