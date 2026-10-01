import type { Database } from 'better-sqlite3'
import { globalDailyCapMicros, validateChannelBudget } from '../../config/budget.js'
import type { ChannelConfig } from '../../config/channel.js'
import { ContentdError } from '../../shared/errors.js'
import { systemTime, type TimeSource } from '../../shared/time.js'

export { globalDailyCapMicros } from '../../config/budget.js'

export interface BudgetExceededDetails {
  scope: 'channel-day' | 'global-day'
  upcomingUsdMicros: number
  spentUsdMicros: number
  capUsdMicros: number
  utcDay: string
}

export class BudgetExceededError extends ContentdError {
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
  time: TimeSource = systemTime,
): void {
  db.prepare(
    'INSERT INTO costs (job_id, provider, operation, usd_micros, attempt_id, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(jobId, provider, operation, usdMicros, attemptId ?? null, time.now().toISOString())
}

// Attribute each row once: job ownership first, otherwise the exact scout:
// prefix used by historical and current scouting. Deleted jobs still count.
const CHANNEL_SPEND_SQL = `
  SELECT CASE WHEN j.id IS NOT NULL THEN j.channel
    WHEN substr(c.job_id, 1, 6) = 'scout:' THEN substr(c.job_id, 7)
    ELSE NULL END AS channel, c.usd_micros
  FROM costs c LEFT JOIN jobs j ON c.job_id = j.id
  WHERE substr(c.created_at, 1, 10) = ?`

export function channelDaySpentMicros(
  db: Database,
  channel: string,
  day = systemTime.now().toISOString().slice(0, 10),
): number {
  return (
    db
      .prepare(
        `SELECT COALESCE(SUM(usd_micros), 0) AS total FROM (${CHANNEL_SPEND_SQL}) WHERE channel = ?`,
      )
      .get(day, channel) as { total: number }
  ).total
}

export function channelDaySpentMicrosByChannel(
  db: Database,
  day = systemTime.now().toISOString().slice(0, 10),
): Map<string, number> {
  const rows = db
    .prepare(
      `SELECT channel, SUM(usd_micros) AS total FROM (${CHANNEL_SPEND_SQL}) WHERE channel IS NOT NULL GROUP BY channel`,
    )
    .all(day) as { channel: string; total: number }[]
  return new Map(rows.map((row) => [row.channel, row.total]))
}

export function globalDaySpentMicros(
  db: Database,
  day = systemTime.now().toISOString().slice(0, 10),
): number {
  return (
    db
      .prepare(
        'SELECT COALESCE(SUM(usd_micros), 0) AS total FROM costs WHERE substr(created_at, 1, 10) = ?',
      )
      .get(day) as { total: number }
  ).total
}

export interface DaySpend {
  day: string
  micros: number
}

export function daySpendBreakdown(
  db: Database,
  days: number,
  time: TimeSource = systemTime,
): DaySpend[] {
  return db
    .prepare(
      `SELECT substr(created_at, 1, 10) AS day, SUM(usd_micros) AS micros
    FROM costs WHERE created_at >= ? GROUP BY day ORDER BY day DESC`,
    )
    .all(new Date(time.now().getTime() - days * 86_400_000).toISOString()) as DaySpend[]
}

function checkCap(
  scope: BudgetExceededDetails['scope'],
  spent: number,
  upcoming: number,
  cap: number,
  day: string,
  channel?: string,
): void {
  if (spent + upcoming > cap) {
    throw new BudgetExceededError(
      `${scope} budget exceeded${channel === undefined ? '' : ` for "${channel}"`}: ${spent + upcoming} > ${cap} usdMicros`,
      { scope, upcomingUsdMicros: upcoming, spentUsdMicros: spent, capUsdMicros: cap, utcDay: day },
    )
  }
}

/** Estimate-based pre-call stop; concurrent calls are not reserved. */
export function assertBudget(
  db: Database,
  channel: ChannelConfig,
  upcomingUsdMicros: number,
  time: Pick<TimeSource, 'now'> = systemTime,
): void {
  const global = globalDailyCapMicros()
  const cap = channel.budget?.perDayUsdMicros
  validateChannelBudget(channel.name, cap, global)
  const day = time.now().toISOString().slice(0, 10)
  checkCap('global-day', globalDaySpentMicros(db, day), upcomingUsdMicros, global, day)
  if (cap !== undefined) {
    checkCap(
      'channel-day',
      channelDaySpentMicros(db, channel.name, day),
      upcomingUsdMicros,
      cap,
      day,
      channel.name,
    )
  }
}
