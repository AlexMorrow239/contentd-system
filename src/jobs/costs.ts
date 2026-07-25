import type { Database } from 'better-sqlite3'
import type { ChannelConfig } from '../config/channel.js'
import type { Tier } from './types.js'

// Operator-level safety net across ALL channels (design spec §5).
const DEFAULT_GLOBAL_DAILY_USD = 25

export class BudgetExceededError extends Error {
  constructor(public reason: string) {
    super(reason)
    this.name = 'BudgetExceededError'
  }
}

export function recordCost(
  db: Database,
  jobId: string,
  provider: string,
  operation: string,
  usdMicros: number,
): void {
  db.prepare(
    'INSERT INTO costs (job_id, provider, operation, usd_micros) VALUES (?, ?, ?, ?)',
  ).run(jobId, provider, operation, usdMicros)
}

// Parsed at call time (not module load) so tests and long-lived processes see
// env changes without a re-import. dotenv is loaded once in src/cli.ts.
export function globalDailyCapMicros(): number {
  const raw = process.env.BRAINROT_GLOBAL_DAILY_USD
  if (raw === undefined || raw.trim() === '') {
    return DEFAULT_GLOBAL_DAILY_USD * 1_000_000
  }
  const usd = Number(raw)
  // A NaN cap would make every `>` comparison false and silently disable the
  // safety net. Fail loudly instead — a plain Error (not BudgetExceededError)
  // so the runner records a crash ('failed'), not a budget outcome ('blocked').
  if (!Number.isFinite(usd) || usd < 0) {
    throw new Error(
      `invalid BRAINROT_GLOBAL_DAILY_USD: ${JSON.stringify(raw)} (expected a non-negative number of USD)`,
    )
  }
  return Math.round(usd * 1_000_000)
}

// Today's UTC spend attributed to one channel. costs has no channel column:
// attribution JOINs through the jobs table, so non-job sentinel rows
// ('scout:<channel>') are invisible here — accepted at ~$0.01/day scale.
export function channelDaySpentMicros(db: Database, channel: string): number {
  const row = db
    .prepare(
      'SELECT COALESCE(SUM(c.usd_micros), 0) AS total FROM costs c JOIN jobs j ON c.job_id = j.id ' +
        "WHERE j.channel = ? AND substr(c.created_at, 1, 10) = strftime('%Y-%m-%d','now')",
    )
    .get(channel) as { total: number }
  return row.total
}

// One job's LIFETIME spend — the quantity the per-video caps are measured
// against (assertBudget uses the same SUM inline). No day filter: a job's
// per-video budget never resets, so a job parked overnight resumes against
// everything it already spent.
export function jobSpentMicros(db: Database, jobId: string): number {
  const row = db
    .prepare('SELECT COALESCE(SUM(usd_micros), 0) AS total FROM costs WHERE job_id = ?')
    .get(jobId) as { total: number }
  return row.total
}

// Today's UTC spend across ALL costs rows — deliberately no jobs JOIN, so
// sentinel scout rows count toward the global cap.
export function globalDaySpentMicros(db: Database): number {
  const row = db
    .prepare(
      "SELECT COALESCE(SUM(usd_micros), 0) AS total FROM costs WHERE substr(created_at, 1, 10) = strftime('%Y-%m-%d','now')",
    )
    .get() as { total: number }
  return row.total
}

// The global-day check extracted from assertBudget so the scout — which has
// no job and therefore cannot use assertBudget — gates its Haiku spend
// against the same ceiling. Cap is resolved BEFORE the db read so a
// malformed env crashes without touching the ledger, exactly as before.
export function assertGlobalDayBudget(db: Database, upcomingUsdMicros: number): void {
  const globalCapMicros = globalDailyCapMicros()
  const globalDayProjected = globalDaySpentMicros(db) + upcomingUsdMicros
  if (globalDayProjected > globalCapMicros) {
    throw new BudgetExceededError(
      `global-day budget exceeded: ${globalDayProjected} > ${globalCapMicros} usdMicros (BRAINROT_GLOBAL_DAILY_USD, default ${DEFAULT_GLOBAL_DAILY_USD})`,
    )
  }
}

/**
 * Pre-call budget checkpoint. Enforces, in order:
 *  1. per-video cap — tier picks the cap (premium → premiumPerVideoUsdMicros),
 *     against the job's lifetime spend
 *  2. channel-day cap — today's UTC spend attributed through the jobs table
 *     vs channel.budget.perDayUsdMicros
 *  3. global-day cap — today's UTC spend across ALL channels vs
 *     BRAINROT_GLOBAL_DAILY_USD (USD, default 25)
 * All comparisons are strict `>` (equal-to-cap passes). Messages start with the
 * cap name (per-video / premium per-video / channel-day / global-day) — the
 * runner surfaces them verbatim as the blocked reason.
 */
export function assertBudget(
  db: Database,
  channel: ChannelConfig,
  jobId: string,
  upcomingUsdMicros: number,
  tier: Tier,
): void {
  const perVideoCap =
    tier === 'premium' ? channel.budget.premiumPerVideoUsdMicros : channel.budget.perVideoUsdMicros
  const perVideoLabel = tier === 'premium' ? 'premium per-video' : 'per-video'
  const jobRow = db
    .prepare('SELECT COALESCE(SUM(usd_micros), 0) AS total FROM costs WHERE job_id = ?')
    .get(jobId) as { total: number }
  const jobProjected = jobRow.total + upcomingUsdMicros
  if (jobProjected > perVideoCap) {
    throw new BudgetExceededError(
      `${perVideoLabel} budget exceeded: ${jobProjected} > ${perVideoCap} usdMicros`,
    )
  }

  const channelDayProjected = channelDaySpentMicros(db, channel.name) + upcomingUsdMicros
  if (channelDayProjected > channel.budget.perDayUsdMicros) {
    throw new BudgetExceededError(
      `channel-day budget exceeded for "${channel.name}": ${channelDayProjected} > ${channel.budget.perDayUsdMicros} usdMicros`,
    )
  }

  assertGlobalDayBudget(db, upcomingUsdMicros)
}
