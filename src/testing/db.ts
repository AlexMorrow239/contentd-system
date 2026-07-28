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
    createdAt: null,
    ...overrides,
  }
  if (row.createdAt === null) {
    db.prepare(
      'INSERT INTO library (job_id, video_path, metadata_json, state) VALUES (?, ?, ?, ?)',
    ).run(jobId, row.videoPath, row.metadataJson, row.state)
  } else {
    db.prepare(
      'INSERT INTO library (job_id, video_path, metadata_json, state, created_at) VALUES (?, ?, ?, ?, ?)',
    ).run(jobId, row.videoPath, row.metadataJson, row.state, row.createdAt)
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

export interface PublishRow {
  platform: string
  channel: string
  day: string
  seq: number
  status: string
  postId: string | null
  url: string | null
  error: string | null
  errorKind: string | null
  attempt: number
  createdAt: string | null
  finishedAt: string | null
}

export function seedPublish(
  db: Database,
  jobId: string,
  overrides: Partial<PublishRow> = {},
): number {
  const row = {
    platform: 'youtube',
    channel: 'chan-a',
    // The suite's canonical fixture day. Tests that assert on `day` (quota
    // windows, listPublishes ranges) pass it explicitly; this default only has
    // to be stable and in the past.
    day: '2026-07-20',
    seq: 1,
    status: 'done',
    postId: null,
    url: null,
    error: null,
    errorKind: null,
    attempt: 1,
    createdAt: null,
    finishedAt: null,
    ...overrides,
  }
  const cols = [
    'job_id',
    'platform',
    'channel',
    'day',
    'seq',
    'status',
    'post_id',
    'url',
    'error',
    'error_kind',
    'attempt',
    'finished_at',
  ]
  const vals: unknown[] = [
    jobId,
    row.platform,
    row.channel,
    row.day,
    row.seq,
    row.status,
    row.postId,
    row.url,
    row.error,
    row.errorKind,
    row.attempt,
    row.finishedAt,
  ]
  if (row.createdAt !== null) {
    cols.push('created_at')
    vals.push(row.createdAt)
  }
  const res = db
    .prepare(
      `INSERT INTO publishes (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
    )
    .run(...vals)
  return Number(res.lastInsertRowid)
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
