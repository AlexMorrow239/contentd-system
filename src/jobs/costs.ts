import type { Database } from 'better-sqlite3'
import type { ChannelConfig } from '../config/channel.js'

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

export function assertBudget(
  db: Database,
  channel: ChannelConfig,
  jobId: string,
  upcomingUsdMicros: number,
): void {
  const jobRow = db
    .prepare('SELECT COALESCE(SUM(usd_micros), 0) AS total FROM costs WHERE job_id = ?')
    .get(jobId) as { total: number }
  const jobProjected = jobRow.total + upcomingUsdMicros
  if (jobProjected > channel.budget.perVideoUsdMicros) {
    throw new BudgetExceededError(
      `per-video budget exceeded: ${jobProjected} > ${channel.budget.perVideoUsdMicros} usdMicros`,
    )
  }

  const dayRow = db
    .prepare(
      "SELECT COALESCE(SUM(usd_micros), 0) AS total FROM costs WHERE substr(created_at, 1, 10) = strftime('%Y-%m-%d','now')",
    )
    .get() as { total: number }
  const dayProjected = dayRow.total + upcomingUsdMicros
  if (dayProjected > channel.budget.perDayUsdMicros) {
    throw new BudgetExceededError(
      `per-day budget exceeded: ${dayProjected} > ${channel.budget.perDayUsdMicros} usdMicros`,
    )
  }
}
