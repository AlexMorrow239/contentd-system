import type { Database } from 'better-sqlite3'
import type { ChannelConfig } from '../../../../daemon/src/config/channel.js'
import {
  channelDaySpentMicrosByChannel,
  globalDailyCapMicros,
  globalDaySpentMicros,
} from '../../../../daemon/src/jobs/costs.js'

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
  capUsdMicros: number | null
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
   * Global spend not attributed to a configured channel, including historical
   * channels without a current TOML and unknown job IDs. Scout rows belonging
   * to configured channels are included in channelSpend.
   */
  unattributedUsdMicros: number
  leases: LeaseState[]
}

export function buildOverview(db: Database, channels: ChannelConfig[], now: Date): OverviewData {
  const jobsByStatus = db
    .prepare(
      'SELECT status, COUNT(*) AS count FROM jobs WHERE deleted_at IS NULL GROUP BY status ORDER BY count DESC',
    )
    .all() as StatusCount[]

  const last24h = db
    .prepare(
      "SELECT COUNT(*) AS count FROM jobs WHERE deleted_at IS NULL AND created_at >= strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 day')",
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
        "WHERE jobs.deleted_at IS NULL AND jobs.status IN ('failed','blocked') " +
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

  const globalSpentUsdMicros = globalDaySpentMicros(db, now.toISOString().slice(0, 10))
  // One GROUP BY for every channel rather than a SUM per channel: this page
  // renders the whole set every refresh. A channel with no spend today has no
  // entry, hence the 0 default.
  const spentByChannel = channelDaySpentMicrosByChannel(db, now.toISOString().slice(0, 10))
  const channelSpend = channels.map((channel) => ({
    channel: channel.name,
    spentUsdMicros: spentByChannel.get(channel.name) ?? 0,
    capUsdMicros: channel.budget?.perDayUsdMicros ?? null,
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
