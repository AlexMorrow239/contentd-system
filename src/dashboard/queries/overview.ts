import type { Database } from 'better-sqlite3'
import type { ChannelConfig } from '../../config/channel.js'
import {
  channelDaySpentMicros,
  globalDailyCapMicros,
  globalDaySpentMicros,
} from '../../jobs/costs.js'

export interface StatusCount {
  status: string
  count: number
}

export interface AttentionJob {
  id: string
  channel: string
  topic: string
  status: 'failed' | 'blocked'
  /** The stage that failed, or null for a budget block with no stage error. */
  stage: string | null
  error: string | null
}

export interface LeaseState {
  name: string
  holder: string
  expiresAt: string
  expired: boolean
}

export interface SpendAgainstCap {
  spentUsdMicros: number
  capUsdMicros: number
}

export interface ChannelSpend extends SpendAgainstCap {
  channel: string
}

export interface OverviewData {
  jobsByStatus: StatusCount[]
  jobsLast24h: number
  attention: AttentionJob[]
  libraryByState: StatusCount[]
  globalSpend: SpendAgainstCap
  channelSpend: ChannelSpend[]
  /**
   * globalSpend minus the sum of channelSpend. Per-channel attribution goes
   * through the jobs table (see channelDaySpentMicros), so it excludes cost
   * rows with no matching jobs row — e.g. the scout's 'scout:<channel>'
   * sentinel rows — and any job whose channel TOML has since been renamed
   * or deleted. globalDaySpentMicros (the figure the global budget cap
   * actually enforces) has no such filter. The two are deliberately not
   * meant to reconcile; this field makes that gap visible instead of
   * leaving it implied. Clamped at 0 so it never renders negative.
   */
  unattributedUsdMicros: number
  leases: LeaseState[]
}

export function buildOverview(db: Database, channels: ChannelConfig[], now: Date): OverviewData {
  const jobsByStatus = db
    .prepare('SELECT status, COUNT(*) AS count FROM jobs GROUP BY status ORDER BY count DESC')
    .all() as StatusCount[]

  const last24h = db
    .prepare(
      "SELECT COUNT(*) AS count FROM jobs WHERE created_at >= strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 day')",
    )
    .get() as { count: number }

  // failed vs blocked matters: blocked is budget ENFORCEMENT (a thrown
  // BudgetExceededError), not a crash, and it may have no failing stage row
  // at all — hence the LEFT JOIN rather than an inner one.
  const attention = db
    .prepare(
      'SELECT jobs.id AS id, jobs.channel AS channel, jobs.topic AS topic, jobs.status AS status, ' +
        'stage.stage AS stage, stage.error AS error FROM jobs ' +
        "LEFT JOIN job_stages stage ON stage.job_id = jobs.id AND stage.status = 'failed' " +
        "WHERE jobs.status IN ('failed','blocked') " +
        'ORDER BY jobs.created_at DESC LIMIT 50',
    )
    .all() as {
    id: string
    channel: string
    topic: string
    status: 'failed' | 'blocked'
    stage: string | null
    error: string | null
  }[]

  const libraryByState = db
    .prepare(
      'SELECT state AS status, COUNT(*) AS count FROM library GROUP BY state ORDER BY status',
    )
    .all() as StatusCount[]

  const leases = (
    db.prepare('SELECT name, holder, expires_at FROM leases ORDER BY name').all() as {
      name: string
      holder: string
      expires_at: string
    }[]
  ).map((row) => ({
    name: row.name,
    holder: row.holder,
    expiresAt: row.expires_at,
    // An expired-but-present lease is a crashed holder: the next tick will
    // take it over, but seeing it explains a stalled loop.
    expired: new Date(row.expires_at).getTime() < now.getTime(),
  }))

  const globalSpentUsdMicros = globalDaySpentMicros(db)
  const channelSpend = channels.map((channel) => ({
    channel: channel.name,
    spentUsdMicros: channelDaySpentMicros(db, channel.name),
    capUsdMicros: channel.budget.perDayUsdMicros,
  }))
  const attributedUsdMicros = channelSpend.reduce((sum, entry) => sum + entry.spentUsdMicros, 0)

  return {
    jobsByStatus,
    jobsLast24h: last24h.count,
    attention,
    libraryByState,
    globalSpend: {
      spentUsdMicros: globalSpentUsdMicros,
      capUsdMicros: globalDailyCapMicros(),
    },
    channelSpend,
    unattributedUsdMicros: Math.max(0, globalSpentUsdMicros - attributedUsdMicros),
    leases,
  }
}
