import type { Database } from 'better-sqlite3'
import type { ChannelConfig } from '../../config/channel.js'
import type { PublishRow, PublishStatus } from '../../publish/publishes.js'
import type { Platform, PublishErrorKind } from '../../publish/types.js'
import { localDay } from '../../publish/schedule.js'

export interface GridRow {
  platform: Platform
  seq: number
}

export interface ChannelGrid {
  channel: string
  /**
   * Row headers for the grid: one row per (platform, ordinal) pair, the
   * ordinals running 1..max(videos_per_day, highest seq seen in the window
   * for that platform) — seq can run ahead of videos_per_day once retries or
   * failures are counted, so the row count widens rather than clipping a real
   * publish off the grid. Each platform gets its own rows, so a publish
   * attempt on one platform never overwrites or hides the other's. Sorted by
   * ordinal first, then platform, for a stable, readable grid.
   */
  rows: GridRow[]
  /** Newest day first. */
  days: string[]
  /** Keyed by cellKey(day, seq, platform). Absent means that ordinal was never reached. */
  cells: Map<string, PublishRow>
}

export function cellKey(day: string, seq: number, platform: Platform): string {
  return `${day} ${String(seq)} ${platform}`
}

interface DbPublishRow {
  id: number
  job_id: string
  platform: Platform
  channel: string
  day: string
  seq: number
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
    seq: row.seq,
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
 * The grid's row count comes from CHANNEL CONFIG, not solely from the
 * publishes table: an attempt that never happened has no row, and inferring
 * the shape purely from existing rows would hide exactly those gaps. It is
 * only ever widened by the fetched rows (never narrowed), so a publish that
 * landed past videos_per_day — a retry, or a same-day video beyond the
 * configured count — still gets a row rather than vanishing from the grid.
 * Channels with no [publish] table never enter the publish pool and are
 * omitted entirely.
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
    'SELECT id, job_id, platform, channel, day, seq, status, post_id, url, error, ' +
      'error_kind, attempt, created_at, finished_at FROM publishes ' +
      'WHERE channel = ? AND day >= ? AND day <= ? ORDER BY id ASC',
  )

  // flatMap rather than filter-then-map: it drops channels with no declared
  // platforms in one step. `tiktok` is filtered out here — this grid is keyed
  // by the upload adapters' Platform (youtube/instagram only), and a
  // declared-but-not-yet-adapted platform has no publishes rows to show.
  return channels.flatMap((channel): ChannelGrid[] => {
    const targetPlatforms = channel.platforms.filter((p): p is Platform => p !== 'tiktok')
    if (targetPlatforms.length === 0) return []
    const dbRows = statement.all(channel.name, oldest, dayList[0]) as DbPublishRow[]
    const cells = new Map<string, PublishRow>()
    // ORDER BY id ASC plus overwrite means the newest attempt for a cell
    // wins, which is what the UNIQUE(channel,platform,day,seq) constraint
    // makes near-certain anyway.
    for (const row of dbRows) {
      cells.set(cellKey(row.day, row.seq, row.platform), toPublishRow(row))
    }
    // seq counts every prior row for the (channel, platform, day) — retries
    // and failures included, not just successes — so it can run ahead of
    // videos_per_day (e.g. a failed attempt 1 plus a successful retry at
    // seq 2 plus a same-day third video at seq 3, with videos_per_day = 2).
    // Row count per platform is therefore the larger of videos_per_day and
    // the highest seq actually seen in the fetched window, so a live publish
    // that ran past the configured ordinal still gets a row instead of
    // silently vanishing from the grid.
    const maxSeqByPlatform = new Map<Platform, number>()
    for (const row of dbRows) {
      const current = maxSeqByPlatform.get(row.platform) ?? 0
      if (row.seq > current) maxSeqByPlatform.set(row.platform, row.seq)
    }
    // One row per (platform, ordinal) pair, with the ordinals coming from the
    // channel's videos_per_day (widened as above): an attempt that never
    // happened has no publishes row, and inferring the shape from existing
    // rows alone would hide exactly those gaps. Two platforms never collapse
    // into one row, so a publish on one platform can't hide or overwrite the
    // other's.
    const rows: GridRow[] = targetPlatforms.flatMap((platform) => {
      const rowCount = Math.max(channel.videosPerDay, maxSeqByPlatform.get(platform) ?? 0)
      return Array.from({ length: rowCount }, (_unused, i) => ({
        platform,
        seq: i + 1,
      }))
    })
    rows.sort((a, b) => {
      if (a.seq !== b.seq) return a.seq - b.seq
      return a.platform < b.platform ? -1 : a.platform > b.platform ? 1 : 0
    })

    return [{ channel: channel.name, rows, days: dayList, cells }]
  })
}

export interface InterruptedPublish {
  jobId: string
  channel: string
  platform: string
  createdAt: string
}

/**
 * Uploads whose outcome the daemon could not confirm — publish-next's repair
 * sweep never guesses whether the video actually landed. They are the only
 * rows an operator resolves by hand, which is why they get their own section
 * with the two actions that resolve them.
 */
export function interruptedPublishes(db: Database): InterruptedPublish[] {
  return db
    .prepare(
      `SELECT job_id AS jobId, channel, platform, created_at AS createdAt
       FROM publishes WHERE status = 'interrupted' ORDER BY created_at ASC, id ASC`,
    )
    .all() as InterruptedPublish[]
}
