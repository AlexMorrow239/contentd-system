import type { Database } from 'better-sqlite3'
import { systemTime, type TimeSource } from '../time.js'

/**
 * How far back the visuals stage looks to avoid repeating a background clip.
 * Nothing prunes `bg_usage`, so this window — not the table — is what bounds
 * the policy: rows older than the last `RECENT_BG_WINDOW` for a channel are
 * kept but never read.
 */
export const RECENT_BG_WINDOW = 5

/** Most-recently-used first, so the caller can treat the result as a window. */
export function recentBackgrounds(
  db: Database,
  channel: string,
  limit: number = RECENT_BG_WINDOW,
): string[] {
  const rows = db
    .prepare('SELECT file FROM bg_usage WHERE channel = ? ORDER BY used_at DESC LIMIT ?')
    .all(channel, limit) as { file: string }[]
  return rows.map((r) => r.file)
}

export function recordBackgroundUse(
  db: Database,
  channel: string,
  file: string,
  time: TimeSource = systemTime,
): void {
  db.prepare('INSERT INTO bg_usage (channel, file, used_at) VALUES (?, ?, ?)').run(
    channel,
    file,
    time.now().toISOString(),
  )
}
