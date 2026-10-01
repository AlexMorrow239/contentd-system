import type Anthropic from '@anthropic-ai/sdk'
import type { Database } from 'better-sqlite3'
import type { ChannelConfig } from '../../config/channel.js'
import { LeaseLostError, type LeaseContext } from '../../infra/coordination/lease.js'
import { errorCostUsdMicros } from '../../infra/providers/errors.js'
import { isMediaPostKind } from '../../infra/sources/post-kind.js'
import { redditSource } from '../../infra/sources/reddit.js'
import type { FetchLike, TrendCandidate } from '../../infra/sources/types.js'
import { SOURCE_FETCH_TIMEOUT_MS, dedupeHash } from '../../infra/sources/types.js'
import { errorMessage, retagWithContext } from '../../shared/errors.js'
import { STORY_WORDS_PER_PART, splitStory } from '../../shared/stories/split.js'
import { resolveTime, type TimeSource } from '../../shared/time.js'
import { assertBudget, recordCost } from '../billing/costs.js'
import { insertTopics } from '../topics/mutations.js'
import { candidateTopicCount, knownHashes, recentTopicTitles } from '../topics/queries.js'
import type { NewTopic } from '../topics/types.js'
import type { ScoredCandidate } from './score.js'
import { ESTIMATED_SCOUT_COST_MICROS, estimatedChunkCount, scoreCandidates } from './score.js'
import { lastScoutAttemptAt, recordScoutAttempt } from './scout-state.js'
import type { ScoutChannelResult } from './types.js'

/**
 * The all-zero result, in one place. Every field of ScoutChannelResult is a
 * count or a list, so "nothing happened" has exactly one spelling — and the
 * three surfaces that need it (the two skip gates and scoutAll's fallback for
 * a channel that threw before building its own result) each spelled out all
 * eleven fields, which is eleven chances for a new field to be forgotten in
 * two of them.
 */
export function emptyChannelResult(
  channel: string,
  overrides: Partial<ScoutChannelResult> = {},
): ScoutChannelResult {
  return {
    channel,
    fetched: 0,
    droppedMedia: 0,
    droppedAutomated: 0,
    droppedBodyless: 0,
    alreadyKnown: 0,
    scored: 0,
    queued: 0,
    rejected: 0,
    sourceErrors: [],
    costUsdMicros: 0,
    ...overrides,
  }
}

// The one score gate. A constant, not config (design 2026-07-28): topics
// below this are never stored, so the queue only ever holds topics worth
// producing. min_score was removed from channel TOML in the same change.
export const SCOUT_MIN_SCORE = 80

// The floor between two scout attempts for ONE channel, so a quiet subreddit
// isn't refetched on every 30-second daemon poll. Persisted in `scout_state`
// (not in-memory) so the gate survives a daemon restart and is shared with a
// manual `brainrot scout` run — see `--force` on that command to bypass it.
export const SCOUT_RECHECK_MS = 1_200_000 // 20 min

// Scoring with the ledger-complete error path: gate first; if the call spent
// before failing (paid-but-invalid response), record that spend before the
// error propagates.
async function scoreWithLedger(
  db: Database,
  channel: ChannelConfig,
  fresh: { candidate: TrendCandidate; hash: string }[],
  result: ScoutChannelResult,
  time: TimeSource,
  client?: Anthropic,
  lease?: LeaseContext,
): Promise<{ scored: ScoredCandidate[]; costUsdMicros: number }> {
  try {
    // Preflight the batch, then recheck each paid chunk with its unledgered
    // spend. Final accounting remains atomic with topic insertion below.
    assertBudget(db, channel, ESTIMATED_SCOUT_COST_MICROS * estimatedChunkCount(fresh.length), time)
    return await scoreCandidates({
      candidates: fresh.map((f) => f.candidate),
      niche: channel.niche,
      recentTitles: recentTopicTitles(db, channel.name),
      story: channel.story !== null,
      client,
      lease,
      beforeChunk: (spent) => assertBudget(db, channel, spent + ESTIMATED_SCOUT_COST_MICROS, time),
    })
  } catch (err) {
    const spent = errorCostUsdMicros(err)
    if (spent !== undefined) {
      recordCost(db, `scout:${channel.name}`, 'anthropic', 'scout-score', spent, undefined, time)
      result.costUsdMicros += spent
    }
    // Carry the partial ScoutChannelResult across the rethrow so scoutAll can
    // report real fetch/dedupe counts for a channel whose scoring failed.
    // Tagged rather than subclassed: the original error identity must survive
    // (callers match on BudgetExceededError / ZodError).
    throw retagWithContext(err, { partial: result })
  }
}

export async function scoutChannel(
  db: Database,
  channel: ChannelConfig,
  opts: {
    client?: Anthropic
    fetchImpl?: FetchLike
    time?: TimeSource
    force?: boolean
    lease?: LeaseContext
  } = {},
): Promise<ScoutChannelResult> {
  const time = resolveTime(opts.time, opts.lease)
  opts.lease?.assertOwned()
  const now = time.now()

  // Recheck gate FIRST — cheaper than the depth query below (a single indexed
  // lookup vs a COUNT), and a channel whose last attempt is still fresh has
  // nothing new to learn from either query.
  if (!opts.force) {
    const last = lastScoutAttemptAt(db, channel.name)
    if (last !== null && now.getTime() - last.getTime() < SCOUT_RECHECK_MS) {
      return emptyChannelResult(channel.name, { skipped: 'recheck-not-due' })
    }
  }
  // The attempt is recorded as soon as the channel clears the recheck gate —
  // BEFORE the queue-full check and before any fetch/score work — so the
  // clock bumps for every channel actually attempted (queue-full, real work,
  // or a scoring failure that throws below), matching what a caller means by
  // "we looked at this channel just now".
  db.transaction(() => {
    opts.lease?.assertOwned()
    recordScoutAttempt(db, channel.name, now)
  }).immediate()

  // Depth gate — ahead of the source loop, so a channel with enough queued
  // candidates costs neither a network fetch nor a Haiku scoring call. The
  // scoring calls are where the money is, so gating after fetching would save
  // almost nothing.
  const queueCap = Math.ceil(channel.videosPerDay * channel.scout.queueDays)
  if (candidateTopicCount(db, channel.name) >= queueCap) {
    return emptyChannelResult(channel.name, { skipped: 'queue-full' })
  }

  const sourceErrors: string[] = []
  const candidates: TrendCandidate[] = []
  // Per-source isolation: a malformed subreddit name, a failed fetch, or a
  // timeout contributes zero candidates and one sourceErrors entry; the run
  // continues (spec §4). The source is constructed inside the try because its
  // constructor is what rejects a malformed name.
  for (const subreddit of channel.scout.subreddits) {
    try {
      opts.lease?.assertOwned()
      candidates.push(
        ...(await redditSource(subreddit, opts.fetchImpl).fetch({
          limit: channel.scout.perSourceLimit,
          timeoutMs: SOURCE_FETCH_TIMEOUT_MS,
          signal: opts.lease?.signal,
          time,
        })),
      )
      opts.lease?.assertOwned()
    } catch (err) {
      opts.lease?.assertOwned()
      if (err instanceof LeaseLostError) throw err
      const entry = `reddit:r/${subreddit}: ${errorMessage(err)}`
      // Spec §4: a failing source "logs a warning" — stderr, since stdout is
      // reserved for the CLI's single JSON line.
      console.error(`scout: source ${entry}`)
      sourceErrors.push(entry)
    }
  }

  // Policy lives here, not in the source: redditSource annotates, the scout
  // decides. An image post is a photograph with no narrative substance — the
  // scorer sees only titles, so "Milky way over Yosemite" reads as a strong
  // topic and scored 89. Dropping pre-scoring also means Haiku is never paid
  // to rate one.
  //
  // Dropped items get no topics row: re-dropping them next tick is free (the
  // filter is deterministic and pre-LLM), and the table keeps meaning "things
  // we actually considered".
  const notMedia = candidates.filter((c) => !isMediaPostKind(c.postKind))

  // The other thing the scorer cannot see: AutoModerator's recurring scheduled
  // threads. Each week's instance is a distinct t3_ id, so the dedupe filter
  // below never catches them — without this they cost a scoring slot every
  // week, forever, across every subreddit that runs one.
  const usable = notMedia.filter((c) => c.automated !== true)

  // Story channels narrate the post itself, so a candidate with no body is
  // unusable no matter how good its title is — r/AskReddit's posts are all of
  // this shape. Dropped pre-scoring, like the media filter above, so Haiku is
  // never paid to rate one. Gated on channel.story so a topic-mode channel
  // behaves exactly as it did before this filter existed.
  const story = channel.story
  const narratable =
    story === null
      ? usable
      : // defensive: c.body !== '' can never fire in practice — storyBody
        // returns either undefined or a trimmed string of at least
        // STORY_MIN_BODY_WORDS words, never ''. Kept explicit so a future
        // reader does not infer an empty-but-present body is a real case.
        usable.filter((c) => c.body !== undefined && c.body !== '')

  const result: ScoutChannelResult = {
    channel: channel.name,
    // fetched stays the raw count, so
    // fetched - droppedMedia - droppedAutomated - droppedBodyless - alreadyKnown
    // reads as scored. A second relation an operator might assume from this
    // same JSON line — queued + rejected = scored — held before story mode
    // existed but no longer does: one scored story post fans out into
    // multiple queued (or rejected) rows, so queued can exceed scored.
    fetched: candidates.length,
    droppedMedia: candidates.length - notMedia.length,
    droppedAutomated: notMedia.length - usable.length,
    droppedBodyless: usable.length - narratable.length,
    alreadyKnown: 0,
    scored: 0,
    queued: 0,
    rejected: 0,
    sourceErrors,
    costUsdMicros: 0,
  }

  // Hash-filter BEFORE scoring: known items never reach Haiku again, so scout
  // re-runs are free and rejected topics stay rejected without re-spend.
  const hashes = narratable.map((c) => dedupeHash(c.sourceId, c.externalId))
  const known = knownHashes(db, channel.name, hashes)
  const fresh = narratable
    .map((candidate, i) => ({ candidate, hash: hashes[i] }))
    .filter((f) => !known.has(f.hash))
  result.alreadyKnown = narratable.length - fresh.length
  if (fresh.length === 0) return result

  result.scored = fresh.length
  opts.lease?.assertOwned()
  const scored = await scoreWithLedger(db, channel, fresh, result, time, opts.client, opts.lease)
  result.costUsdMicros = scored.costUsdMicros

  // Topic mode: one row per candidate, exactly as before. Story mode: a
  // queued candidate becomes one row PER PART, which is what makes each part
  // an ordinary one-job-one-video unit downstream. A rejected story stays a
  // single row — splitting it would multiply the queue's noise for no
  // benefit, and the part hashes would never be looked up again.
  const rows: NewTopic[] = []
  for (const s of scored.scored) {
    const { candidate, hash } = fresh[s.candidateIndex]
    const status = s.score >= SCOUT_MIN_SCORE ? 'candidate' : 'rejected'
    const base = {
      channel: channel.name,
      rawTitle: candidate.title,
      source: candidate.sourceId,
      url: candidate.url,
      targetUrl: candidate.targetUrl,
      score: s.score,
      reason: s.reason,
      sourceContext: candidate.sourceContext,
    }
    if (story === null || status === 'rejected' || candidate.body === undefined) {
      rows.push({ ...base, title: s.topic, dedupeHash: hash, status })
      continue
    }
    const { parts, truncated } = splitStory(candidate.body, STORY_WORDS_PER_PART, story.maxParts)
    if (parts.length === 0) {
      // Unreachable in practice (a body that cleared STORY_MIN_BODY_WORDS
      // always yields at least one part) but silent otherwise — without this,
      // a post that scored 80+ would be discarded with no trace. Matches the
      // per-source failure path above: stderr, since stdout is reserved for
      // the CLI's one JSON line.
      console.error(`scout: channel "${channel.name}" split produced no parts for "${s.topic}"`)
      rows.push({ ...base, title: s.topic, dedupeHash: hash, status: 'rejected' })
      continue
    }
    parts.forEach((bodyText, i) => {
      const partIndex = i + 1
      rows.push({
        ...base,
        // No (1/1) on a single-part story; the suffix is only meaningful when
        // there is a part 2 to look for.
        title: parts.length > 1 ? `${s.topic} (${partIndex}/${parts.length})` : s.topic,
        // Suffixed on EVERY part including the first, so parts dedupe
        // independently and the scheme is uniform.
        dedupeHash: dedupeHash(candidate.sourceId, `${candidate.externalId}#p${partIndex}`),
        status,
        bodyText,
        seriesKey: hash,
        partIndex,
        partCount: parts.length,
        truncated,
      })
    })
  }
  result.queued = rows.filter((r) => r.status === 'candidate').length
  result.rejected = rows.length - result.queued
  // Ledger row and dedupe hashes commit together: a kill between them would
  // keep the charge and lose the hashes, so the next run re-pays Haiku for the
  // very same items. better-sqlite3 nests insertTopics' own transaction as a
  // savepoint, so the wrap is safe.
  try {
    db.transaction(() => {
      opts.lease?.assertOwned()
      // Sentinel job id: the global-day query sums scout spend too.
      recordCost(
        db,
        `scout:${channel.name}`,
        'anthropic',
        'scout-score',
        scored.costUsdMicros,
        undefined,
        time,
      )
      insertTopics(db, rows, time)
    }).immediate()
  } catch (err) {
    // Ownership can expire between the last scoring check and this commit.
    // Its transaction rolled back; retain the paid response without topics.
    if (err instanceof LeaseLostError || opts.lease?.signal.aborted) {
      recordCost(
        db,
        `scout:${channel.name}`,
        'anthropic',
        'scout-score',
        scored.costUsdMicros,
        undefined,
        time,
      )
    }
    throw err
  }
  return result
}
