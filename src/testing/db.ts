import path from 'node:path'
import type { Database } from 'better-sqlite3'
import { openDb } from '../db/index.js'
import { tmpDir, trackDb } from './tmp.js'

/**
 * Db scaffolding for tests. Two open helpers plus one seed builder per table,
 * all `(db, id?, overrides?)` so a test declares only the columns it asserts
 * on. This replaces ~24 bare `openDb(':memory:')` calls in
 * scout/topics.test.ts alone, plus the per-file `tempDb()`/`setup()`/
 * `tempDbPath()` forks in jobs/costs, jobs/runner and db/index.
 *
 * Foreign keys are OFF by design (see openDb), but every builder still writes
 * a realistic row: several DAOs JOIN through jobs, so a child row with no
 * parent silently disappears from results rather than failing loudly.
 */

/** In-memory db, closed after the file finishes. The default for unit tests. */
export function memDb(): Database {
  return trackDb(openDb(':memory:'))
}

/**
 * File-backed db in a temp dir, closed and removed after the file finishes.
 * Needed when a test spawns the CLI (a subprocess cannot see `:memory:`) or
 * asserts on WAL/concurrency behavior.
 */
export function fileDb(name = 'brainrot.db'): { db: Database; dbPath: string; root: string } {
  const root = tmpDir('brainrot-db-')
  const dbPath = path.join(root, name)
  return { db: trackDb(openDb(dbPath)), dbPath, root }
}

export interface JobRow {
  channel: string
  tier: string
  topic: string
  status: string
  createdAt: string | null
  finishedAt: string | null
}

export function seedJob(db: Database, id: string, overrides: Partial<JobRow> = {}): string {
  const row = {
    channel: 'chan-a',
    tier: 'volume',
    topic: 'seeded topic',
    status: 'done',
    createdAt: null,
    finishedAt: null,
    ...overrides,
  }
  // created_at has a schema default; passing NULL would override it with NULL,
  // so the column is only named when the caller pinned a value.
  if (row.createdAt === null) {
    db.prepare(
      'INSERT INTO jobs (id, channel, tier, topic, status, finished_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(id, row.channel, row.tier, row.topic, row.status, row.finishedAt)
  } else {
    db.prepare(
      'INSERT INTO jobs (id, channel, tier, topic, status, created_at, finished_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(id, row.channel, row.tier, row.topic, row.status, row.createdAt, row.finishedAt)
  }
  return id
}

export function seedStage(
  db: Database,
  jobId: string,
  stage: string,
  overrides: Partial<{
    status: string
    error: string | null
    startedAt: string | null
    finishedAt: string | null
  }> = {},
): void {
  db.prepare(
    `INSERT INTO job_stages (job_id, stage, status, error, started_at, finished_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(job_id, stage) DO UPDATE SET status = excluded.status`,
  ).run(
    jobId,
    stage,
    overrides.status ?? 'done',
    overrides.error ?? null,
    overrides.startedAt ?? null,
    overrides.finishedAt ?? null,
  )
}

export interface LibraryRow {
  videoPath: string
  metadataJson: string
  state: string
  qcJson: string | null
  createdAt: string | null
}

export function seedLibrary(
  db: Database,
  jobId: string,
  overrides: Partial<LibraryRow> = {},
): void {
  const row = {
    videoPath: `/runs/${jobId}/assemble/final.mp4`,
    metadataJson: '{}',
    state: 'ready',
    qcJson: null,
    createdAt: null,
    ...overrides,
  }
  if (row.createdAt === null) {
    db.prepare(
      'INSERT INTO library (job_id, video_path, metadata_json, state, qc_json) VALUES (?, ?, ?, ?, ?)',
    ).run(jobId, row.videoPath, row.metadataJson, row.state, row.qcJson)
  } else {
    db.prepare(
      'INSERT INTO library (job_id, video_path, metadata_json, state, qc_json, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(jobId, row.videoPath, row.metadataJson, row.state, row.qcJson, row.createdAt)
  }
}

export function seedLibraryObject(
  db: Database,
  jobId: string,
  overrides: Partial<{ objectKey: string; bytes: number; etag: string; reclaimedAt: string }> = {},
): void {
  db.prepare(
    'INSERT INTO library_objects (job_id, object_key, bytes, etag, reclaimed_at) VALUES (?, ?, ?, ?, ?)',
  ).run(
    jobId,
    overrides.objectKey ?? `videos/${jobId}.mp4`,
    overrides.bytes ?? 1024,
    overrides.etag ?? 'etag-1',
    overrides.reclaimedAt ?? null,
  )
}

export interface TopicRow {
  channel: string
  title: string
  rawTitle: string
  source: string
  url: string
  dedupeHash: string
  score: number
  reason: string
  status: string
  jobId: string | null
  createdAt: string | null
  seriesKey: string | null
  partIndex: number | null
  partCount: number | null
}

/** Returns the autoincrement id, which most topic tests assert on. */
export function seedTopic(db: Database, overrides: Partial<TopicRow> = {}): number {
  const title = overrides.title ?? 'A seeded topic'
  const row = {
    channel: 'chan-a',
    title,
    rawTitle: title,
    source: 'reddit',
    // UNIQUE (channel, dedupe_hash): default off the title so repeated seeds
    // in one test collide only when the caller actually meant them to.
    url: `https://example.invalid/${encodeURIComponent(title)}`,
    dedupeHash: title.toLowerCase().replace(/\s+/g, '-'),
    score: 80,
    reason: 'seeded',
    status: 'candidate',
    jobId: null,
    createdAt: null,
    seriesKey: null,
    partIndex: null,
    partCount: null,
    ...overrides,
  }
  const cols = [
    'channel',
    'title',
    'raw_title',
    'source',
    'url',
    'dedupe_hash',
    'score',
    'reason',
    'status',
    'job_id',
    'series_key',
    'part_index',
    'part_count',
  ]
  const vals: unknown[] = [
    row.channel,
    row.title,
    row.rawTitle,
    row.source,
    row.url,
    row.dedupeHash,
    row.score,
    row.reason,
    row.status,
    row.jobId,
    row.seriesKey,
    row.partIndex,
    row.partCount,
  ]
  if (row.createdAt !== null) {
    cols.push('created_at')
    vals.push(row.createdAt)
  }
  const info = db
    .prepare(`INSERT INTO topics (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`)
    .run(...vals)
  return Number(info.lastInsertRowid)
}

export function seedScoutState(db: Database, channel: string, lastAttemptAt: Date): void {
  db.prepare('INSERT INTO scout_state (channel, last_attempt_at) VALUES (?, ?)').run(
    channel,
    lastAttemptAt.toISOString(),
  )
}

export function seedPost(
  db: Database,
  overrides: Partial<{
    jobId: string
    channel: string
    platform: string
    url: string | null
    postedAt: string
  }> = {},
): void {
  const row = {
    jobId: 'job-1',
    channel: 'alpha',
    platform: 'youtube',
    url: null as string | null,
    postedAt: new Date().toISOString(),
    ...overrides,
  }
  db.prepare(
    'INSERT INTO posts (job_id, channel, platform, url, posted_at) VALUES (?, ?, ?, ?, ?)',
  ).run(row.jobId, row.channel, row.platform, row.url, row.postedAt)
}

export function seedCost(
  db: Database,
  jobId: string,
  overrides: Partial<{
    provider: string
    operation: string
    usdMicros: number
    createdAt: string | null
  }> = {},
): void {
  const createdAt = overrides.createdAt ?? null
  if (createdAt === null) {
    db.prepare(
      'INSERT INTO costs (job_id, provider, operation, usd_micros) VALUES (?, ?, ?, ?)',
    ).run(
      jobId,
      overrides.provider ?? 'anthropic',
      overrides.operation ?? 'script',
      overrides.usdMicros ?? 1000,
    )
  } else {
    db.prepare(
      'INSERT INTO costs (job_id, provider, operation, usd_micros, created_at) VALUES (?, ?, ?, ?, ?)',
    ).run(
      jobId,
      overrides.provider ?? 'anthropic',
      overrides.operation ?? 'script',
      overrides.usdMicros ?? 1000,
      createdAt,
    )
  }
}

export interface ActionRowSeed {
  kind: string
  lane: string
  args: string
  status: string
  requestedBy: string
  createdAt: string | null
  startedAt: string | null
  finishedAt: string | null
  result: string | null
  error: string | null
  errorKind: string | null
  notice: string | null
}

/** Returns the autoincrement id, which the queue tests assert on. */
export function seedAction(db: Database, overrides: Partial<ActionRowSeed> = {}): number {
  const row = {
    kind: 'topics.reject',
    lane: 'fast',
    args: '{"ids":[1]}',
    status: 'pending',
    requestedBy: 'dashboard',
    createdAt: null,
    startedAt: null,
    finishedAt: null,
    result: null,
    error: null,
    errorKind: null,
    notice: null,
    ...overrides,
  }
  const cols = [
    'kind',
    'lane',
    'args',
    'status',
    'requested_by',
    'started_at',
    'finished_at',
    'result',
    'error',
    'error_kind',
    'notice',
  ]
  const vals: unknown[] = [
    row.kind,
    row.lane,
    row.args,
    row.status,
    row.requestedBy,
    row.startedAt,
    row.finishedAt,
    row.result,
    row.error,
    row.errorKind,
    row.notice,
  ]
  // created_at has a schema default; naming it with NULL would override the
  // default with NULL, so it is only named when the caller pinned a value.
  if (row.createdAt !== null) {
    cols.push('created_at')
    vals.push(row.createdAt)
  }
  const info = db
    .prepare(
      `INSERT INTO operator_actions (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
    )
    .run(...vals)
  return Number(info.lastInsertRowid)
}

export function seedDaemonState(
  db: Database,
  opts: { pid?: number; startedAt?: Date; lastSeenAt: Date },
): void {
  const startedAt = (opts.startedAt ?? opts.lastSeenAt).toISOString()
  db.prepare(
    `INSERT INTO daemon_state (id, pid, started_at, last_seen_at) VALUES (1, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET pid = excluded.pid, last_seen_at = excluded.last_seen_at`,
  ).run(opts.pid ?? 1234, startedAt, opts.lastSeenAt.toISOString())
}
