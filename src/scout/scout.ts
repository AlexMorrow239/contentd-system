import type { Database } from 'better-sqlite3'
import type Anthropic from '@anthropic-ai/sdk'
import type { ChannelConfig } from '../config/channel.js'
import { recordCost } from '../jobs/costs.js'
import { dedupeHash, SOURCE_FETCH_TIMEOUT_MS } from './sources/types.js'
import type { FetchLike, TrendCandidate, TrendSource } from './sources/types.js'
import { redditSource } from './sources/reddit.js'
import { rssSource } from './sources/rss.js'
import { scoreCandidates } from './score.js'
import { insertTopics, knownHashes, recentTopicTitles } from './topics.js'
import type { NewTopic } from './topics.js'

export interface ScoutChannelResult {
  channel: string
  fetched: number
  alreadyKnown: number
  scored: number
  queued: number
  rejected: number
  sourceErrors: string[]
  costUsdMicros: number
  scoringError?: string
}

export async function scoutChannel(
  db: Database,
  channel: ChannelConfig,
  opts: { client?: Anthropic; fetchImpl?: FetchLike } = {},
): Promise<ScoutChannelResult> {
  const sources: TrendSource[] = [
    ...channel.scout.subreddits.map((sub) => redditSource(sub, opts.fetchImpl)),
    ...channel.scout.rss.map((feed) => rssSource(feed, opts.fetchImpl)),
  ]

  const sourceErrors: string[] = []
  const candidates: TrendCandidate[] = []
  // Per-source isolation: a failed or timed-out source contributes zero
  // candidates and one sourceErrors entry; the run continues (design spec §4).
  for (const source of sources) {
    try {
      candidates.push(
        ...(await source.fetch({
          limit: channel.scout.perSourceLimit,
          timeoutMs: SOURCE_FETCH_TIMEOUT_MS,
        })),
      )
    } catch (err) {
      const entry = `${source.id}: ${err instanceof Error ? err.message : String(err)}`
      // Spec §4: a failing source "logs a warning" — stderr, since stdout is
      // reserved for the CLI's single JSON line.
      console.error(`scout: source ${entry}`)
      sourceErrors.push(entry)
    }
  }

  const result: ScoutChannelResult = {
    channel: channel.name,
    fetched: candidates.length,
    alreadyKnown: 0,
    scored: 0,
    queued: 0,
    rejected: 0,
    sourceErrors,
    costUsdMicros: 0,
  }

  // Hash-filter BEFORE scoring: known items never reach Haiku again, so scout
  // re-runs are free and rejected topics stay rejected without re-spend.
  const hashes = candidates.map((c) => dedupeHash(c.sourceId, c.externalId))
  const known = knownHashes(db, channel.name, hashes)
  const fresh = candidates
    .map((candidate, i) => ({ candidate, hash: hashes[i] }))
    .filter((f) => !known.has(f.hash))
  result.alreadyKnown = candidates.length - fresh.length
  if (fresh.length === 0) return result

  result.scored = fresh.length
  const scored = await scoreCandidates({
    candidates: fresh.map((f) => f.candidate),
    niche: channel.niche,
    recentTitles: recentTopicTitles(db, channel.name),
    client: opts.client,
  })
  result.costUsdMicros = scored.costUsdMicros
  // Sentinel job id: FKs are off by design, and the global-day query sums ALL
  // costs rows, so scout spend counts toward the operator ceiling.
  recordCost(db, `scout:${channel.name}`, 'anthropic', 'scout-score', scored.costUsdMicros)

  const rows: NewTopic[] = scored.scored.map((s) => {
    const { candidate, hash } = fresh[s.candidateIndex]
    return {
      channel: channel.name,
      title: s.topic,
      rawTitle: candidate.title,
      source: candidate.sourceId,
      url: candidate.url,
      dedupeHash: hash,
      score: s.score,
      reason: s.reason,
      // At/above the channel threshold → production queue; below → remembered
      // rejection (the hash filter keeps it away from Haiku forever).
      status: s.score >= channel.scout.minScore ? 'candidate' : 'rejected',
    }
  })
  result.queued = rows.filter((r) => r.status === 'candidate').length
  result.rejected = rows.length - result.queued
  insertTopics(db, rows)
  return result
}
