import type { Database } from 'better-sqlite3'

export function lastScoutAttemptAt(db: Database, channel: string): Date | null {
  const row = db
    .prepare('SELECT last_attempt_at FROM scout_state WHERE channel = ?')
    .get(channel) as { last_attempt_at: string } | undefined
  return row === undefined ? null : new Date(row.last_attempt_at)
}

export function recordScoutAttempt(db: Database, channel: string, at: Date): void {
  db.prepare(
    `INSERT INTO scout_state (channel, last_attempt_at) VALUES (?, ?)
     ON CONFLICT(channel) DO UPDATE SET last_attempt_at = excluded.last_attempt_at`,
  ).run(channel, at.toISOString())
}
