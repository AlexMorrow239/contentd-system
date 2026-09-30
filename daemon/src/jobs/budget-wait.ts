import { createHash } from 'node:crypto'
import type { Database } from 'better-sqlite3'
import { z } from 'zod'
import { errorMessage } from '../errors.js'
import type { ChannelConfig } from '../config/channel.js'
import { BudgetExceededError, assertBudget, globalDailyCapMicros } from './costs.js'

const detailsSchema = z.object({
  // Read historical refusals; new BudgetExceededError instances only use daily scopes.
  scope: z.enum(['per-video', 'channel-day', 'global-day']),
  upcomingUsdMicros: z.number().finite().nonnegative(),
  spentUsdMicros: z.number().finite().nonnegative(),
  capUsdMicros: z.number().finite().nonnegative(),
  utcDay: z.string(),
})
const waitSchema = z.object({
  version: z.literal(1),
  stage: z.string(),
  reason: z.string(),
  utcDay: z.string(),
  configFingerprint: z.string(),
  details: detailsSchema.nullable(),
})
export type BudgetWait = z.infer<typeof waitSchema>

// Parsed configuration includes voice/model choices that can change the next
// estimate. Stable object ordering avoids probes from equivalent config loads.
function fingerprint(channel: ChannelConfig): string {
  let globalBudget: number | { invalid: string | undefined }
  try {
    globalBudget = globalDailyCapMicros()
  } catch {
    // Failure bookkeeping must still work for a custom budget refusal when
    // operator configuration is malformed. Repairing that value allows a probe.
    globalBudget = { invalid: process.env.BRAINROT_GLOBAL_DAILY_USD }
  }
  const serialized = JSON.stringify(
    { channel, globalDailyCapMicros: globalBudget },
    (_key, value: unknown) =>
      value !== null && typeof value === 'object' && !Array.isArray(value)
        ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)))
        : value,
  )
  return createHash('sha256').update(serialized).digest('hex')
}

export function makeBudgetWait(
  err: unknown,
  channel: ChannelConfig,
  stage: string,
  now: Date,
): BudgetWait {
  return {
    version: 1,
    stage,
    reason: errorMessage(err),
    utcDay: now.toISOString().slice(0, 10),
    configFingerprint: fingerprint(channel),
    details: err instanceof BudgetExceededError ? (err.details ?? null) : null,
  }
}

/** SELECTs only. The runner persists each new refusal, consuming a legacy or
 * config-change probe. Known estimates must fit every current budget. */
export function budgetWaitEligible(
  db: Database,
  channel: ChannelConfig,
  raw: string | null,
  now: Date,
): boolean {
  const wait = parseBudgetWait(raw)
  if (wait === null) return true
  if (wait.configFingerprint !== fingerprint(channel)) return true
  const day = now.toISOString().slice(0, 10)
  if (wait.details === null) return wait.utcDay !== day
  const upcoming = wait.details.upcomingUsdMicros
  try {
    assertBudget(db, channel, upcoming, { now: () => now })
    return true
  } catch (err) {
    if (err instanceof BudgetExceededError) return false
    throw err
  }
}

/** Readers tolerate legacy or corrupt metadata; a fresh runner refusal repairs it. */
export function parseBudgetWait(raw: string | null): BudgetWait | null {
  if (raw === null) return null
  try {
    const result = waitSchema.safeParse(JSON.parse(raw))
    return result.success ? result.data : null
  } catch {
    return null
  }
}
