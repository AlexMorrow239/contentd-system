import type { Database } from 'better-sqlite3'
import type { ChannelConfig } from '../../config/channel.js'
import type { PublishRow, PublishStatus } from '../../publish/publishes.js'
import type { Platform, PublishErrorKind } from '../../publish/types.js'
import { localDay } from '../../publish/slots.js'

export interface ChannelGrid {
  channel: string
  /**
   * Row headers for the grid: the deduped, sorted union of every declared
   * target's slots. Targets can each have their own slot list (e.g. youtube
   * at 10:00/14:00/19:00, instagram at 11:00/18:00) — the grid still renders
   * one row per distinct time-of-day, and a slot only one platform declares
   * is simply empty in the other platform's cells.
   */
  slots: string[]
  /** Newest day first. */
  days: string[]
  /** Keyed by cellKey(day, slot). Absent means the slot was never filled. */
  cells: Map<string, PublishRow>
}

export function cellKey(day: string, slot: string): string {
  return `${day} ${slot}`
}

interface DbPublishRow {
  id: number
  job_id: string
  platform: Platform
  channel: string
  day: string
  slot: string
  status: PublishStatus
  post_id: string | null
  url: string | null
  error: string | null
  error_kind: PublishErrorKind | null
  attempt: number
  created_at: string
  finished_at: string | null
}

function toPublishRow(row: DbPublishRow): PublishRow {
  return {
    id: row.id,
    jobId: row.job_id,
    platform: row.platform,
    channel: row.channel,
    day: row.day,
    slot: row.slot,
    status: row.status,
    postId: row.post_id,
    url: row.url,
    error: row.error,
    errorKind: row.error_kind,
    attempt: row.attempt,
    createdAt: row.created_at,
    finishedAt: row.finished_at,
  }
}

/** Local-day strings for the window ending today, newest first. */
function windowDays(days: number, now: Date): string[] {
  const out: string[] = []
  for (let offset = 0; offset < days; offset++) {
    const date = new Date(now)
    date.setDate(date.getDate() - offset)
    out.push(localDay(date))
  }
  return out
}

/**
 * The grid's shape comes from CHANNEL CONFIG, not from the publishes table:
 * a slot that was never filled has no row, and inferring the schedule from
 * existing rows would hide exactly those gaps. Channels with no [publish]
 * table never enter the publish pool and are omitted entirely.
 */
export function buildPublishGrids(
  db: Database,
  channels: ChannelConfig[],
  days: number,
  now: Date,
): ChannelGrid[] {
  const dayList = windowDays(days, now)
  const oldest = dayList[dayList.length - 1]

  const statement = db.prepare(
    'SELECT id, job_id, platform, channel, day, slot, status, post_id, url, error, ' +
      'error_kind, attempt, created_at, finished_at FROM publishes ' +
      'WHERE channel = ? AND day >= ? AND day <= ? ORDER BY id ASC',
  )

  return channels
    .filter((channel) => channel.publish !== null)
    .map((channel) => {
      const rows = statement.all(channel.name, oldest, dayList[0]) as DbPublishRow[]
      const cells = new Map<string, PublishRow>()
      // ORDER BY id ASC plus overwrite means the newest attempt for a cell
      // wins, which is what the UNIQUE(channel,platform,day,slot) constraint
      // makes near-certain anyway.
      for (const row of rows) {
        cells.set(cellKey(row.day, row.slot), toPublishRow(row))
      }
      // Union across targets rather than one target's list: a channel with
      // both youtube and instagram declared can have different slot times
      // per platform, and the grid needs a row for every distinct time any
      // target fills, not just the first target's.
      const slots = [...new Set(channel.publish?.targets.flatMap((t) => t.slots) ?? [])].sort()

      return {
        channel: channel.name,
        slots,
        days: dayList,
        cells,
      }
    })
}
