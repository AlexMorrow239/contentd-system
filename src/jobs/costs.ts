import type { Database } from 'better-sqlite3'
import type { ChannelConfig } from '../config/channel.js'
import { BrainrotError } from '../errors.js'

// Operator-level safety net across ALL channels (design spec §5).
const DEFAULT_GLOBAL_DAILY_USD = 25

export interface BudgetExceededDetails {
  scope: 'per-video' | 'channel-day' | 'global-day'
  upcomingUsdMicros: number
  spentUsdMicros: number
  capUsdMicros: number
  utcDay: string
}

export class BudgetExceededError extends BrainrotError {
  constructor(
    reason: string,
    readonly details?: BudgetExceededDetails,
  ) {
    super(reason, { domain: 'job', kind: 'budget' })
    this.name = 'BudgetExceededError'
  }
}

export function recordCost(
  db: Database,
  jobId: string,
  provider: string,
  operation: string,
  usdMicros: number,
  attemptId?: string,
): void {
  db.prepare(
    'INSERT INTO costs (job_id, provider, operation, usd_micros, attempt_id) VALUES (?, ?, ?, ?, ?)',
  ).run(jobId, provider, operation, usdMicros, attemptId ?? null)
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
export function channelDaySpentMicros(db: Database, channel: string, day?: string): number {
  const row = db
    .prepare(
      'SELECT COALESCE(SUM(c.usd_micros), 0) AS total FROM costs c JOIN jobs j ON c.job_id = j.id ' +
        `WHERE j.channel = ? AND substr(c.created_at, 1, 10) = ${day === undefined ? "strftime('%Y-%m-%d','now')" : '?'}`,
    )
    .get(channel, ...(day === undefined ? [] : [day])) as { total: number }
  return row.total
}

/**
 * `channelDaySpentMicros` for every channel at once — one GROUP BY instead of
 * one SUM per channel, for the surfaces that report the whole set (the
 * overview page, the digest). Same JOIN and therefore the same sentinel-row
 * blindness as the singular form.
 *
 * A channel with no spend today has NO entry: a caller reading the map must
 * default to 0 rather than treat absence as missing data.
 *
 * `day` is a 'YYYY-MM-DD' UTC date; omitted means today, resolved by the same
 * strftime expression the singular form uses so the two can never disagree
 * about where the day boundary falls.
 */
export function channelDaySpentMicrosByChannel(db: Database, day?: string): Map<string, number> {
  const rows = db
    .prepare(
      'SELECT j.channel AS channel, COALESCE(SUM(c.usd_micros), 0) AS total FROM costs c ' +
        'JOIN jobs j ON c.job_id = j.id ' +
        `WHERE substr(c.created_at, 1, 10) = ${day === undefined ? "strftime('%Y-%m-%d','now')" : '?'} ` +
        'GROUP BY j.channel',
    )
    .all(...(day === undefined ? [] : [day])) as { channel: string; total: number }[]
  return new Map(rows.map((row) => [row.channel, row.total]))
}

// One job's LIFETIME spend — the quantity the per-video caps are measured
// against, and the single read assertBudget enforces them through. No day
// filter: a job's per-video budget never resets, so a job parked overnight
// resumes against everything it already spent.
export function jobSpentMicros(db: Database, jobId: string): number {
  const row = db
    .prepare('SELECT COALESCE(SUM(usd_micros), 0) AS total FROM costs WHERE job_id = ?')
    .get(jobId) as { total: number }
  return row.total
}

// Today's UTC spend across ALL costs rows — deliberately no jobs JOIN, so
// sentinel scout rows count toward the global cap.
export function globalDaySpentMicros(db: Database, day?: string): number {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(usd_micros), 0) AS total FROM costs WHERE substr(created_at, 1, 10) = ${day === undefined ? "strftime('%Y-%m-%d','now')" : '?'}`,
    )
    .get(...(day === undefined ? [] : [day])) as { total: number }
  return row.total
}

export interface DaySpend {
  day: string
  micros: number
}

/**
 * Spend per UTC day over a trailing window, newest first — the `brainrot
 * costs` report. Like `globalDaySpentMicros` there is no jobs JOIN, so
 * sentinel scout rows are included; unlike it, a day with no rows is simply
 * absent rather than reported as zero.
 */
export function daySpendBreakdown(db: Database, days: number): DaySpend[] {
  return db
    .prepare(
      `SELECT substr(created_at, 1, 10) AS day, SUM(usd_micros) AS micros
       FROM costs
       WHERE created_at >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ?)
       GROUP BY day
       ORDER BY day DESC`,
    )
    .all(`-${days} days`) as DaySpend[]
}

// The global-day check extracted from assertBudget so the scout — which has
// no job and therefore cannot use assertBudget — gates its Haiku spend
// against the same ceiling. Cap is resolved BEFORE the db read so a
// malformed env crashes without touching the ledger, exactly as before.
export function assertGlobalDayBudget(db: Database, upcomingUsdMicros: number): void {
  const globalCapMicros = globalDailyCapMicros()
  const utcDay = new Date().toISOString().slice(0, 10)
  const spentUsdMicros = globalDaySpentMicros(db, utcDay)
  const globalDayProjected = spentUsdMicros + upcomingUsdMicros
  if (globalDayProjected > globalCapMicros) {
    throw new BudgetExceededError(
      `global-day budget exceeded: ${globalDayProjected} > ${globalCapMicros} usdMicros (BRAINROT_GLOBAL_DAILY_USD, default ${DEFAULT_GLOBAL_DAILY_USD})`,
      {
        scope: 'global-day',
        upcomingUsdMicros,
        spentUsdMicros,
        capUsdMicros: globalCapMicros,
        utcDay,
      },
    )
  }
}

/**
 * Pre-call budget checkpoint. Enforces, in order:
 *  1. per-video cap — channel.budget.perVideoUsdMicros, against the job's
 *     lifetime spend
 *  2. channel-day cap — today's UTC spend attributed through the jobs table
 *     vs channel.budget.perDayUsdMicros
 *  3. global-day cap — today's UTC spend across ALL channels vs
 *     BRAINROT_GLOBAL_DAILY_USD (USD, default 25)
 * All comparisons are strict `>` (equal-to-cap passes). Messages start with the
 * cap name (per-video / channel-day / global-day) — the runner surfaces them
 * verbatim as the blocked reason.
 */
export function assertBudget(
  db: Database,
  channel: ChannelConfig,
  jobId: string,
  upcomingUsdMicros: number,
): void {
  // Invalid operator configuration must fail before a narrower cap can throw
  // a budget refusal; otherwise failure bookkeeping could mask the config error.
  globalDailyCapMicros()
  const utcDay = new Date().toISOString().slice(0, 10)
  const perVideoCap = channel.budget.perVideoUsdMicros
  const jobProjected = jobSpentMicros(db, jobId) + upcomingUsdMicros
  if (jobProjected > perVideoCap) {
    throw new BudgetExceededError(
      `per-video budget exceeded: ${jobProjected} > ${perVideoCap} usdMicros`,
      {
        scope: 'per-video',
        upcomingUsdMicros,
        spentUsdMicros: jobProjected - upcomingUsdMicros,
        capUsdMicros: perVideoCap,
        utcDay,
      },
    )
  }

  const channelDayProjected = channelDaySpentMicros(db, channel.name, utcDay) + upcomingUsdMicros
  if (channelDayProjected > channel.budget.perDayUsdMicros) {
    throw new BudgetExceededError(
      `channel-day budget exceeded for "${channel.name}": ${channelDayProjected} > ${channel.budget.perDayUsdMicros} usdMicros`,
      {
        scope: 'channel-day',
        upcomingUsdMicros,
        spentUsdMicros: channelDayProjected - upcomingUsdMicros,
        capUsdMicros: channel.budget.perDayUsdMicros,
        utcDay,
      },
    )
  }

  assertGlobalDayBudget(db, upcomingUsdMicros)
}
