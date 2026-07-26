import type { Database } from 'better-sqlite3'
import type { ChannelConfig } from '../../config/channel.js'
import type { PublishRow, PublishStatus } from '../../publish/publishes.js'
import type { Platform, PublishErrorKind } from '../../publish/types.js'
import { localDay } from '../../publish/slots.js'

export interface GridRow {
  platform: Platform
  slot: string
}

export interface ChannelGrid {
  channel: string
  /**
   * Row headers for the grid: one row per distinct (platform, slot) pair
   * declared by any target. Targets can each have their own slot list (e.g.
   * youtube at 10:00/14:00/19:00, instagram at 10:00/18:00) — even when two
   * platforms share the same time-of-day, each gets its own row, so a
   * publish attempt on one platform never overwrites or hides the other's.
   * Sorted by slot time first, then platform, for a stable, readable grid.
   */
  rows: GridRow[]
  /** Newest day first. */
  days: string[]
  /** Keyed by cellKey(day, slot, platform). Absent means the slot was never filled. */
  cells: Map<string, PublishRow>
}

export function cellKey(day: string, slot: string, platform: Platform): string {
  return `${day} ${slot} ${platform}`
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

  // flatMap rather than filter-then-map: it drops the unpublished channels
  // AND narrows `publish` away from null in one step, so the targets below
  // need no second null check the filter already ruled out.
  return channels.flatMap((channel): ChannelGrid[] => {
    const publish = channel.publish
    if (publish === null) return []
    const dbRows = statement.all(channel.name, oldest, dayList[0]) as DbPublishRow[]
    const cells = new Map<string, PublishRow>()
    // ORDER BY id ASC plus overwrite means the newest attempt for a cell
    // wins, which is what the UNIQUE(channel,platform,day,slot) constraint
    // makes near-certain anyway.
    for (const row of dbRows) {
      cells.set(cellKey(row.day, row.slot, row.platform), toPublishRow(row))
    }
    // One row per (platform, slot) pair rather than per distinct time: two
    // platforms declaring the identical slot time (the natural shared
    // `[publish] slots = [...]` configuration) must not collapse into one
    // row, or one platform's attempts would be indistinguishable from the
    // other's in the grid. The pairs are unique by construction —
    // buildTargets emits at most one target per platform, and
    // slotsFieldSchema rejects duplicate slots within one — so no dedupe.
    const rows: GridRow[] = publish.targets.flatMap((target) =>
      target.slots.map((slot) => ({ platform: target.platform, slot })),
    )
    rows.sort((a, b) => {
      if (a.slot !== b.slot) return a.slot < b.slot ? -1 : 1
      return a.platform < b.platform ? -1 : a.platform > b.platform ? 1 : 0
    })

    return [{ channel: channel.name, rows, days: dayList, cells }]
  })
}
