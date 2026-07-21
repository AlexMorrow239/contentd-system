import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Database } from 'better-sqlite3'
import { openDb } from '../db/index.js'
import { buildDigest, ZOMBIE_RUNNING_MS } from './digest.js'

const HOUR_MS = 3_600_000
const DAY_MS = 24 * HOUR_MS

// Explicit timestamps in the schema default's own format ('...T...Z' with
// millis) keep string comparisons against created_at meaningful.
function isoAgo(ms: number): string {
  return new Date(Date.now() - ms).toISOString()
}

function seedJob(
  db: Database,
  opts: {
    id: string
    channel?: string
    tier?: 'volume' | 'premium'
    status?: 'queued' | 'running' | 'failed' | 'done' | 'blocked'
    createdAt?: string
  },
): void {
  db.prepare(
    'INSERT INTO jobs (id, channel, tier, topic, status, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(
    opts.id,
    opts.channel ?? 'chan-a',
    opts.tier ?? 'volume',
    'digest test topic',
    opts.status ?? 'done',
    opts.createdAt ?? isoAgo(HOUR_MS),
  )
}

// Library rows carry the ready/needs-review outcome for 'done' jobs — the
// same insert shape the runner's library upsert writes.
function seedLibrary(db: Database, jobId: string, state: 'ready' | 'needs-review'): void {
  db.prepare(
    "INSERT INTO library (job_id, video_path, metadata_json, state) VALUES (?, '/tmp/out.mp4', '{}', ?)",
  ).run(jobId, state)
}

function seedTopic(
  db: Database,
  opts: {
    dedupeHash: string
    channel?: string
    status?: 'candidate' | 'approved' | 'claimed' | 'used' | 'rejected'
    createdAt?: string
  },
): void {
  db.prepare(
    'INSERT INTO topics (channel, title, raw_title, source, url, dedupe_hash, score, reason, status, created_at) ' +
      "VALUES (?, 'digest topic', 'raw', 'reddit:r/space', 'https://example.com', ?, 70, 'test', ?, ?)",
  ).run(
    opts.channel ?? 'chan-a',
    opts.dedupeHash,
    opts.status ?? 'candidate',
    opts.createdAt ?? isoAgo(HOUR_MS),
  )
}

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('buildDigest — topics section', () => {
  it('exports the 2h zombie constant', () => {
    expect(ZOMBIE_RUNNING_MS).toBe(7_200_000)
  })

  it('counts last-24h topics per channel by status, excluding older rows', () => {
    const db = openDb(':memory:')
    seedTopic(db, { dedupeHash: 'h1', status: 'candidate' })
    seedTopic(db, { dedupeHash: 'h2', status: 'candidate' })
    seedTopic(db, { dedupeHash: 'h3', status: 'approved' })
    seedTopic(db, { dedupeHash: 'h4', status: 'rejected' })
    // 3 days old — outside every reading of the 24h window
    seedTopic(db, { dedupeHash: 'h5', createdAt: isoAgo(3 * DAY_MS) })
    seedTopic(db, { channel: 'chan-b', dedupeHash: 'h6', status: 'rejected' })
    const digest = buildDigest(db, [])
    expect(digest).toContain('Topics (last 24h)')
    expect(digest).toContain('  chan-a: 4 scouted — 2 candidate, 1 approved, 1 rejected')
    expect(digest).toContain('  chan-b: 1 scouted — 0 candidate, 0 approved, 1 rejected')
    db.close()
  })

  it('prints none when no topics were scouted in the last 24h', () => {
    const db = openDb(':memory:')
    expect(buildDigest(db, [])).toContain('Topics (last 24h)\n  none')
    db.close()
  })
})
