import type { Database } from 'better-sqlite3'
import type { ChannelConfig } from '../../config/channel.js'
import {
  normalizePlatformMeta,
  platformEntrySchema,
  renderCaption,
  renderDescription,
  renderTags,
  type PlatformMeta,
} from '../../posts/meta.js'
import { postedPlatforms } from '../../posts/posts.js'
import type { Platform } from '../../posts/types.js'
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
  object_key: string | null
  reclaimed_at: string | null
  series_key: string | null
  part_index: number | null
  part_count: number | null
}

/**
 * One platform's paste blocks. YouTube is the only platform with a separate
 * title field and a tags array; Instagram and TikTok take one composed
 * caption. Everything here goes through the same normalizers the deleted
 * adapters used, so what the page shows is what the platform will accept.
 *
 * A missing or malformed entry yields an empty body rather than throwing —
 * the same containment summarizeQc applies to one bad metadata blob, so a
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
  if (platform === 'youtube') {
    return {
      platform,
      posted,
      url,
      title: meta.title,
      body: renderDescription(meta.description, meta.hashtags),
      tags: renderTags(meta.hashtags).join(', '),
    }
  }
  return { platform, posted, url, title: null, body: renderCaption(meta), tags: null }
}

/**
 * The manual posting queue: ready videos with at least one declared platform
 * still unposted, oldest first.
 *
 * Oldest-first is load-bearing, not cosmetic — story parts must go out in
 * order, and working down the page in the order it renders is what makes that
 * happen without the operator tracking it.
 *
 * The fully-posted exclusion is the SAME correlated-subquery shape
 * pendingInventory uses. Those two must agree on what "fully posted" means:
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

  const cards: PostCard[] = []
  const limit = opts?.limit ?? 200
  for (const channel of withPlatforms) {
    const marks = channel.platforms.map(() => '?').join(', ')
    const rows = db
      .prepare(
        `SELECT l.job_id, j.channel, j.topic, l.created_at, l.video_path, l.metadata_json,
                lo.object_key, lo.reclaimed_at,
                t.series_key, t.part_index, t.part_count
         FROM library l
         JOIN jobs j ON j.id = l.job_id
         LEFT JOIN library_objects lo ON lo.job_id = l.job_id
         LEFT JOIN topics t ON t.job_id = l.job_id
         WHERE j.channel = ? AND l.state = 'ready'
           AND (SELECT COUNT(*) FROM posts p
                WHERE p.job_id = l.job_id AND p.platform IN (${marks})) < ?
         ORDER BY l.created_at ASC, l.job_id ASC
         LIMIT ?`,
      )
      .all(channel.name, ...channel.platforms, channel.platforms.length, limit) as DbPostQueueRow[]

    // One grouped read carrying both the posted set and each post's url.
    const posted = postedPlatforms(
      db,
      rows.map((r) => r.job_id),
    )

    for (const row of rows) {
      let meta: Record<string, unknown> = {}
      try {
        const parsed: unknown = JSON.parse(row.metadata_json)
        if (typeof parsed === 'object' && parsed !== null) meta = parsed as Record<string, unknown>
      } catch {
        // Contained to this row, exactly as summarizeQc does.
      }
      const declared = declaredBy.get(row.channel) ?? []
      cards.push({
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
      })
    }
  }
  // Oldest first ACROSS channels — the per-channel queries above each order
  // their own rows, and a page that grouped by channel would hide the oldest
  // video behind whichever channel happened to sort first.
  return cards.sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0))
}
