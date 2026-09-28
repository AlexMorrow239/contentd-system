import type { Database } from 'better-sqlite3'
import type { ChannelConfig } from '../../../../src/config/channel.js'
import {
  normalizePlatformMeta,
  PASTE_FIELDS,
  platformEntrySchema,
  type PlatformMeta,
} from '../../../../src/posts/meta.js'
import { fullyPostedClause, postedPlatforms } from '../../../../src/posts/posts.js'
import type { Platform } from '../../../../src/posts/types.js'
import { libraryBytes, type LibraryBytes } from './library.js'

export interface PostCardPlatform {
  platform: Platform
  posted: boolean
  url: string | null
  /** YouTube only; the composed caption carries the title for the others. */
  title: string | null
  /** What to paste: YouTube's description+hashtags, or the others' full caption. */
  body: string
  /** YouTube only: the bare tags array, comma-joined for pasting. */
  tags: string | null
}

export interface PostCard {
  jobId: string
  channel: string
  topic: string
  createdAt: string
  bytes: LibraryBytes
  seriesLabel: string | null // 'part 2/4'
  platforms: PostCardPlatform[]
}

interface DbPostQueueRow {
  job_id: string
  channel: string
  topic: string
  created_at: string
  video_path: string
  metadata_json: string
  series_key: string | null
  part_index: number | null
  part_count: number | null
}

/**
 * One platform's paste blocks: bounded by the platform's own normalizer, then
 * composed by its PASTE_FIELDS entry — which platform has a title field and
 * which takes one composed caption is a fact about the platform, owned beside
 * those bounds in posts/meta.ts rather than re-decided by a branch here.
 *
 * A missing or malformed entry yields an empty body rather than throwing —
 * the same containment summarizeQc applies to one bad qc verdict, so a
 * single corrupt row cannot take the whole queue down.
 */
function cardPlatform(
  platform: Platform,
  raw: unknown,
  posted: boolean,
  url: string | null,
): PostCardPlatform {
  const parsed = platformEntrySchema.safeParse(raw)
  if (!parsed.success) {
    return { platform, posted, url, title: null, body: '', tags: null }
  }
  const meta: PlatformMeta = normalizePlatformMeta(parsed.data, platform)
  return { platform, posted, url, ...PASTE_FIELDS[platform](meta) }
}

/**
 * The manual posting queue: ready videos with at least one declared platform
 * still unposted, oldest first.
 *
 * Oldest-first is load-bearing, not cosmetic — story parts must go out in
 * order, and working down the page in the order it renders is what makes that
 * happen without the operator tracking it.
 *
 * The fully-posted exclusion is fullyPostedClause, the same fragment
 * pendingInventory builds. Those two must agree on what "fully posted" means:
 * a card that vanishes from this page while still counting as inventory would
 * halt production with nothing on screen to explain it.
 */
export function listPostQueue(
  db: Database,
  channels: ChannelConfig[],
  opts?: { limit?: number },
): PostCard[] {
  const withPlatforms = channels.filter((c) => c.platforms.length > 0)
  if (withPlatforms.length === 0) return []
  const declaredBy = new Map(withPlatforms.map((c) => [c.name, c.platforms]))

  // One read across every channel, not one per channel: each channel declares
  // its own platform set, so its own fully-posted test is OR'd in beside its
  // name. `limit` is consequently a cap on the PAGE, not per channel — which
  // is what the oldest-first ordering above already implies it should be.
  const params: unknown[] = []
  const perChannel = withPlatforms.map((channel) => {
    const unposted = fullyPostedClause(channel.platforms, { alias: 'l', match: 'not-fully' })
    params.push(channel.name, ...unposted.params)
    return `(j.channel = ? AND ${unposted.sql})`
  })
  const limit = opts?.limit ?? 200
  params.push(limit)

  const rows = db
    .prepare(
      `SELECT l.job_id, j.channel, j.topic, l.created_at, l.video_path, l.metadata_json,
              t.series_key, t.part_index, t.part_count
       FROM library l
       JOIN jobs j ON j.id = l.job_id
       LEFT JOIN topics t ON t.job_id = l.job_id
       WHERE l.state = 'ready' AND (${perChannel.join(' OR ')})
       ORDER BY l.created_at ASC, l.job_id ASC
       LIMIT ?`,
    )
    .all(...params) as DbPostQueueRow[]

  // One grouped read carrying both the posted set and each post's url.
  const posted = postedPlatforms(
    db,
    rows.map((r) => r.job_id),
  )

  return rows.map((row) => {
    let meta: Record<string, unknown> = {}
    try {
      const parsed: unknown = JSON.parse(row.metadata_json)
      if (typeof parsed === 'object' && parsed !== null) meta = parsed as Record<string, unknown>
    } catch {
      // Contained to this row, exactly as summarizeQc does.
    }
    const declared = declaredBy.get(row.channel) ?? []
    return {
      jobId: row.job_id,
      channel: row.channel,
      topic: row.topic,
      createdAt: row.created_at,
      bytes: libraryBytes(row),
      seriesLabel:
        row.part_index !== null && row.part_count !== null && row.part_count > 1
          ? `part ${row.part_index}/${row.part_count}`
          : null,
      platforms: declared.map((p) =>
        cardPlatform(
          p,
          meta[p],
          posted.get(row.job_id)?.has(p) ?? false,
          posted.get(row.job_id)?.get(p) ?? null,
        ),
      ),
    }
  })
}
