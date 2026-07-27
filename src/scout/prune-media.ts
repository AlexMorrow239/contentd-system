import type { Database } from 'better-sqlite3'
import { errorMessage } from '../errors.js'
import { parseFeedCandidates } from './sources/feed.js'
import { classifyTarget } from './sources/post-kind.js'
import { REDDIT_USER_AGENT, redditLinkTarget } from './sources/reddit.js'
import { SOURCE_FETCH_TIMEOUT_MS, dedupeHash } from './sources/types.js'
import type { FetchLike } from './sources/types.js'
import { redditCandidates, rejectTopicWithReason, setTopicTargetUrl } from './topics.js'

// Reddit rate-limits hard on this endpoint. Measured 2026-07-27: three
// back-to-back feed fetches all returned 429, and a first pass over a real
// 15-row queue at 2s spacing lost 14 rows to 429. ~20s spacing is what
// actually got through. A one-off cleanup can afford to be slow — a pass that
// skips most of the queue cannot. Injected so tests never sleep.
export const PRUNE_FETCH_DELAY_MS = 20_000

// One retry per row, after a longer pause, so a single rate-limit blip does
// not cost that row its whole pass. Still bounded: a persistently limited
// endpoint gives up and reports rather than grinding.
export const PRUNE_RETRY_MULTIPLIER = 3

export const PRUNE_REJECT_REASON = 'prune-media: submission target is an image'

export interface PruneMediaResult {
  checked: number
  rejected: number
  skipped: { topicId: number; reason: string }[]
}

export interface PruneMediaOpts {
  channel?: string
  dryRun?: boolean
  fetchImpl?: FetchLike
  delayMs?: number
  // Per-row progress. At ~20s a row this command runs for minutes, and one
  // that prints nothing for that long reads as hung. The CLI sends these to
  // stderr, keeping stdout's single-JSON-line contract intact.
  onProgress?: (progress: { index: number; total: number; topicId: number; outcome: string }) => void
}

function sleep(ms: number): Promise<void> {
  return ms <= 0 ? Promise.resolve() : new Promise((resolve) => setTimeout(resolve, ms))
}

// A stored permalink ends in '/', which the feed suffix replaces rather than
// appends to — '.../milky_way/.rss' is not a route reddit serves.
function permalinkFeedUrl(url: string): string {
  return `${url.replace(/\/+$/, '')}.rss`
}

/**
 * Re-classify existing reddit candidates against the media filter.
 *
 * `topics.url` is the comments permalink, not the submission target, and rows
 * written before `target_url` existed carry no target — so each row must be
 * re-fetched. NOT via `.json`, which 403s unauthenticated (verified live
 * 2026-07-27, a 190KB block page), consistent with the note in
 * `sources/reddit.ts`; the permalink's `.rss` is an ordinary Atom document.
 *
 * Every skip is reported and leaves the row untouched. A row is rejected only
 * on positive evidence that its target is media AND that the feed describes
 * the same submission the row does.
 *
 * Runs outside the scout lease, like the other manual `topics` subcommands —
 * an operator action that can race a live cron tick.
 */
export async function pruneMedia(
  db: Database,
  opts: PruneMediaOpts = {},
): Promise<PruneMediaResult> {
  const fetchImpl = opts.fetchImpl ?? fetch
  const delayMs = opts.delayMs ?? PRUNE_FETCH_DELAY_MS
  const rows = redditCandidates(db, opts.channel)
  const result: PruneMediaResult = { checked: 0, rejected: 0, skipped: [] }

  // Resolve one row to its submission target, or to the reason it could not
  // be resolved. Split out so the loop below has exactly one place to record
  // an outcome and report progress, rather than a `continue` per failure mode.
  async function resolveTarget(
    row: (typeof rows)[number],
  ): Promise<{ target: string } | { skip: string }> {
    try {
      const get = (): Promise<Response> =>
        fetchImpl(permalinkFeedUrl(row.url), {
          headers: { 'User-Agent': REDDIT_USER_AGENT },
          signal: AbortSignal.timeout(SOURCE_FETCH_TIMEOUT_MS),
        })
      let res = await get()
      // 429 is the expected failure here, and it is transient by definition.
      // Back off once before giving the row up.
      if (res.status === 429) {
        await sleep(delayMs * PRUNE_RETRY_MULTIPLIER)
        res = await get()
      }
      if (!res.ok) return { skip: `http-${res.status}` }
      const entries = parseFeedCandidates(await res.text(), row.source, `prune-media: ${row.url}`)
      // Comments are t1_; the submission is the only t3_ entry, and the only
      // one carrying a [link] anchor.
      const submission = entries.find((e) => e.externalId.startsWith('t3_'))
      if (submission === undefined) return { skip: 'no-submission-entry' }
      // Identity check: dedupe_hash is sha256(source + externalId), so
      // recomputing it from the feed's own id proves this feed describes this
      // row. Without it a redirected or recycled permalink could attach one
      // post's target to another post's row — and then reject it.
      if (dedupeHash(row.source, submission.externalId) !== row.dedupeHash) {
        return { skip: 'identity-mismatch' }
      }
      const target = redditLinkTarget(submission.contentHtml)
      return target === undefined ? { skip: 'no-link-anchor' } : { target }
    } catch (err) {
      return { skip: errorMessage(err) }
    }
  }

  for (const [i, row] of rows.entries()) {
    if (i > 0) await sleep(delayMs)
    result.checked += 1
    const resolved = await resolveTarget(row)

    let outcome: string
    if ('skip' in resolved) {
      result.skipped.push({ topicId: row.id, reason: resolved.skip })
      outcome = `skipped (${resolved.skip})`
    } else {
      const isImage = classifyTarget(resolved.target) === 'image'
      if (isImage) result.rejected += 1
      if (opts.dryRun !== true) {
        setTopicTargetUrl(db, row.id, resolved.target)
        if (isImage) rejectTopicWithReason(db, row.id, PRUNE_REJECT_REASON)
      }
      outcome = isImage ? `image -> reject (${resolved.target})` : `kept (${resolved.target})`
    }
    opts.onProgress?.({ index: i + 1, total: rows.length, topicId: row.id, outcome })
  }
  return result
}
