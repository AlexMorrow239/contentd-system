import type { Database } from 'better-sqlite3'

/**
 * Fixtures shared by the `publishes.*.test.ts` files.
 *
 * Only the helpers that are genuinely publishes-specific live here — plain job
 * and library rows come from `src/testing/db.ts`. These were previously
 * declared at three different depths inside one 1134-line file (seedPublish sat
 * between the markPublishFailed and sweepInterrupted describes), which is what
 * made the file hard to split.
 */

export const DAY_MS = 24 * 60 * 60 * 1000

/**
 * Explicit timestamps offset from the real clock, so the
 * `datetime('now', ...)` window comparisons inside listPublishes stay
 * meaningful.
 */
export function isoAgo(ms: number): string {
  return new Date(Date.now() - ms).toISOString()
}

/**
 * Transaction mode leaves no trace in the resulting rows, so it is asserted
 * white-box: wrap db.transaction and record which runner the DAO invokes.
 *
 * The plain call is a deferred BEGIN, whose read snapshot a concurrent writer
 * can invalidate — SQLITE_BUSY_SNAPSHOT is the one busy error busy_timeout
 * cannot retry, which is why these writes run `.immediate()`.
 */
export function recordTransactionModes(db: Database): string[] {
  const modes: string[] = []
  const original = db.transaction.bind(db)
  db.transaction = ((fn: (...args: unknown[]) => unknown) => {
    const txn = original(fn as never) as unknown as {
      (...args: unknown[]): unknown
      immediate(...args: unknown[]): unknown
    }
    const wrapped = ((...args: unknown[]) => {
      modes.push('deferred')
      return txn(...args)
    }) as unknown as typeof txn
    wrapped.immediate = (...args: unknown[]) => {
      modes.push('immediate')
      return txn.immediate(...args)
    }
    return wrapped
  }) as unknown as Database['transaction']
  return modes
}
