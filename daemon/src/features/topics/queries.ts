import type { Database } from 'better-sqlite3'
import { whereClause } from '../../infra/db/sql.js'
import type { StoryPart } from '../../shared/stories/types.js'
import { DbTopicRow, TOPIC_COLUMNS, toTopicRow } from './records.js'
import { TopicFilter, TopicRow } from './types.js'

// Pre-Haiku hash filter: any status counts as known (a rejected item must
// never be re-scored). IN-list size is bounded by the scout's per-source
// candidate caps, far under SQLite's bound-variable limit.
//
// Matches against dedupe_hash OR series_key. A topic-mode candidate's hash is
// only ever written to dedupe_hash, so this is the same lookup it always was.
// A story's PARTS are stored under derived per-part hashes
// (`dedupeHash(sourceId, "${externalId}#pN")`) — the un-suffixed base hash the
// caller asks about here is never a row's own dedupe_hash, only its
// series_key. Matching dedupe_hash alone would therefore never recognize an
// already-queued (or already-rejected) story post, re-paying Haiku for it on
// every tick still inside the source's fetch window.
export function knownHashes(db: Database, channel: string, hashes: string[]): Set<string> {
  if (hashes.length === 0) return new Set()
  const placeholders = hashes.map(() => '?').join(', ')
  const rows = db
    .prepare(
      `SELECT dedupe_hash AS h FROM topics WHERE channel = ? AND dedupe_hash IN (${placeholders}) ` +
        `UNION ` +
        `SELECT series_key AS h FROM topics WHERE channel = ? AND series_key IN (${placeholders})`,
    )
    .all(channel, ...hashes, channel, ...hashes) as { h: string }[]
  return new Set(rows.map((r) => r.h))
}

// Scorer prompt context: how many recent titles feed the "recently covered —
// score near-duplicates 0" instruction (design spec §5).
export const RECENT_TITLES_LIMIT = 30

// Rejected topics are noise (near-duplicates, off-niche); the scorer only
// needs what the channel actually covered or queued.
//
// One title per STORY (not per row): a story's parts are one row each with
// near-identical titles ("X (1/4)", "X (2/4)", ...), so at the corpus's
// measured ~3.3 parts/story counting every row would let ~9 distinct stories
// crowd out what used to be a 30-distinct-topic window, while the scorer's
// "recently covered" prompt fills up with near-duplicate strings that all
// describe the same post. Topic-mode rows (series_key NULL) have no series to
// collapse and keep counting individually. The representative for a series is
// its lowest part_index among non-rejected rows (recomputed per row via the
// correlated MIN so a rejected part_index=1 doesn't hide the rest of an
// otherwise-live series), with the "(i/N)" queue suffix stripped since it is
// not part of the story's actual title.
const PART_SUFFIX = /\s*\(\d+\/\d+\)\s*$/

// The scorer's window deliberately excludes rejected rows — a topic scored
// below SCOUT_MIN_SCORE is stale/off-niche noise, not something worth telling
// the scorer "recently covered".
export function recentTopicTitles(
  db: Database,
  channel: string,
  limit = RECENT_TITLES_LIMIT,
): string[] {
  const rows = db
    .prepare(
      `SELECT t1.title AS title, t1.series_key AS seriesKey FROM topics t1
       WHERE t1.channel = ? AND t1.status != 'rejected'
         AND (t1.series_key IS NULL OR t1.part_index = (
           SELECT MIN(t2.part_index) FROM topics t2
           WHERE t2.channel = t1.channel AND t2.series_key = t1.series_key
             AND t2.status != 'rejected'
         ))
       ORDER BY t1.created_at DESC, t1.id DESC LIMIT ?`,
    )
    .all(channel, limit) as { title: string; seriesKey: string | null }[]
  return rows.map((r) => (r.seriesKey === null ? r.title : r.title.replace(PART_SUFFIX, '')))
}

// Queue depth for the scout's own gate: only 'candidate' rows count. A
// 'claimed' topic is already in a job, and 'used'/'rejected' are history —
// counting any of them would let a channel's past keep it from scouting.
export function candidateTopicCount(db: Database, channel: string): number {
  const row = db
    .prepare("SELECT COUNT(*) AS n FROM topics WHERE channel = ? AND status = 'candidate'")
    .get(channel) as { n: number }
  return row.n
}

// The sibling read the digest's topic-starvation check needs: a 'claimed'
// topic is spoken for by a live job, so a channel holding only claimed rows
// has an empty queue for scouting purposes but is not yet starved.
export function claimedTopicCount(db: Database, channel: string): number {
  const row = db
    .prepare("SELECT COUNT(*) AS n FROM topics WHERE channel = ? AND status = 'claimed'")
    .get(channel) as { n: number }
  return row.n
}

function topicWhere(filter?: TopicFilter) {
  return whereClause([
    ['channel = ?', filter?.channel],
    ['status = ?', filter?.status],
    ["instr(lower(title || ' ' || id), lower(?)) > 0", filter?.q],
  ])
}

export function countTopics(db: Database, filter?: TopicFilter): number {
  const { clause, params } = topicWhere(filter)
  return (
    db.prepare(`SELECT COUNT(*) AS count FROM topics${clause}`).get(...params) as { count: number }
  ).count
}

// CLI callers retain their unlimited, newest-first list. Dashboard pages sort
// by score before pagination, so an older high-scoring topic is still reachable.
export function listTopics(
  db: Database,
  filter?: TopicFilter & { limit?: number; offset?: number; order?: 'score' },
): TopicRow[] {
  const { clause, params } = topicWhere(filter)
  const limitClause = filter?.limit !== undefined ? ' LIMIT ? OFFSET ?' : ''
  if (filter?.limit !== undefined) params.push(filter.limit, filter.offset ?? 0)
  const order = filter?.order === 'score' ? 'score DESC, id ASC' : 'created_at DESC, id DESC'
  const rows = db
    .prepare(`SELECT ${TOPIC_COLUMNS} FROM topics${clause} ORDER BY ${order}${limitClause}`)
    .all(...params) as DbTopicRow[]
  return rows.map(toTopicRow)
}

export function eligibleTopic(db: Database, channel: string): TopicRow | null {
  const row = db
    .prepare(
      `SELECT ${TOPIC_COLUMNS} FROM topics WHERE channel = ? AND status = 'candidate' ` +
        'ORDER BY score DESC, created_at ASC, id ASC LIMIT 1',
    )
    .get(channel) as DbTopicRow | undefined
  return row === undefined ? null : toTopicRow(row)
}

/**
 * The story payload for a job, resolved through the topic row `claimTopic`
 * bound to it. Null for a topic-mode job, for a manual `contentd produce` job
 * (no topic row at all), and for a story row missing its body — all three are
 * the same thing to the caller: run the ordinary script path.
 *
 * This is how the payload survives a resume without any new `jobs` column:
 * the topic row outlives the run, and runJob reads it fresh every time.
 */
export function storyPartForJob(db: Database, jobId: string): StoryPart | null {
  const row = db
    .prepare(
      // job_id carries no unique constraint; claimTopic maintains the invariant
      // of one row per job. Ordering by id makes the choice deterministic rather
      // than index-dependent if that invariant is ever broken.
      'SELECT body_text, part_index, part_count, url, truncated FROM topics WHERE job_id = ? ORDER BY id LIMIT 1',
    )
    .get(jobId) as
    | {
        body_text: string | null
        part_index: number | null
        part_count: number | null
        url: string
        truncated: number
      }
    | undefined
  if (row === undefined) return null
  if (row.body_text === null || row.part_index === null || row.part_count === null) return null
  return {
    bodyText: row.body_text,
    partIndex: row.part_index,
    partCount: row.part_count,
    sourceUrl: row.url,
    truncated: row.truncated === 1,
  }
}

export function topicForJob(db: Database, jobId: string): TopicRow | null {
  const row = db
    .prepare(`SELECT ${TOPIC_COLUMNS} FROM topics WHERE job_id = ? ORDER BY id LIMIT 1`)
    .get(jobId) as DbTopicRow | undefined
  return row === undefined ? null : toTopicRow(row)
}
