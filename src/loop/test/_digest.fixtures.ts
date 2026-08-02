import type { Database } from 'better-sqlite3'
import { testChannel } from '../../testing/channel.js'
import * as kit from '../../testing/db.js'
import { DEFAULT_SCOUT } from '../../config/channel.js'
import type { ChannelConfig } from '../../config/channel.js'

/**
 * Fixtures shared by the `digest.*.test.ts` files.
 *
 * These wrap `src/testing/db.ts` rather than issuing their own INSERTs: the
 * digest tests want an options-object call shape with digest-flavored defaults
 * (ages expressed via isoAgo, a fixed publish day), while the SQL itself has
 * no business being duplicated per module. ~170 lines of this used to sit
 * above the first describe in a single 964-line file, with one more helper
 * buried between two describes 800 lines down.
 */

export const HOUR_MS = 3_600_000
export const DAY_MS = 24 * HOUR_MS

// Same filler-key idiom as tokens.test.ts: AES-256 sized, never a real
// secret, and only ever handed to encrypt/decrypt round-trips here.
export const TEST_KEY = Buffer.alloc(32, 0x42)
export const TEST_KEY_HEX = TEST_KEY.toString('hex')
export const OTHER_KEY_HEX = Buffer.alloc(32, 0x11).toString('hex')

/**
 * The env-dependent digest checks (blocked-job reasons, token health) read
 * process.env by default; tests pass explicit presence flags so a developer's
 * own .env can never flip an assertion.
 */
export const ENV_OK = {
  ytClientIdPresent: true,
  ytClientSecretPresent: true,
  tokenKeyHex: TEST_KEY_HEX,
}

/**
 * Explicit timestamps in the schema default's own format ('...T...Z' with
 * millis) keep string comparisons against created_at meaningful.
 */
export function isoAgo(ms: number): string {
  return new Date(Date.now() - ms).toISOString()
}

export function seedJob(
  db: Database,
  opts: {
    id: string
    channel?: string
    status?: 'queued' | 'running' | 'failed' | 'done' | 'blocked'
    createdAt?: string
  },
): void {
  kit.seedJob(db, opts.id, {
    channel: opts.channel ?? 'chan-a',
    topic: 'digest test topic',
    status: opts.status ?? 'done',
    createdAt: opts.createdAt ?? isoAgo(HOUR_MS),
  })
}

/**
 * Library rows carry the ready/needs-review outcome for 'done' jobs.
 * `createdAt` is only used by tests that need to control backlog age
 * precisely; omitting it keeps the schema default ('now').
 */
export function seedLibrary(
  db: Database,
  jobId: string,
  state: 'ready' | 'needs-review',
  createdAt?: string,
): void {
  kit.seedLibrary(db, jobId, { videoPath: '/tmp/out.mp4', state, createdAt: createdAt ?? null })
}

export function seedLibraryPath(db: Database, jobId: string, videoPath: string): void {
  kit.seedLibrary(db, jobId, { videoPath, state: 'ready' })
}

/**
 * day/seq default to fixed values so tests control the
 * UNIQUE (channel, platform, day, seq) constraint explicitly.
 */
export function seedPublish(
  db: Database,
  opts: {
    jobId: string
    channel?: string
    platform?: 'youtube' | 'instagram'
    day?: string
    seq?: number
    status?: 'claimed' | 'done' | 'failed' | 'interrupted'
    url?: string | null
    error?: string | null
    errorKind?: 'auth' | 'quota' | 'rejected' | 'transient' | null
    attempt?: number
    createdAt?: string
  },
): void {
  kit.seedPublish(db, opts.jobId, {
    platform: opts.platform ?? 'youtube',
    channel: opts.channel ?? 'chan-a',
    day: opts.day ?? '2026-07-19',
    seq: opts.seq ?? 1,
    status: opts.status ?? 'done',
    url: opts.url ?? null,
    error: opts.error ?? null,
    errorKind: opts.errorKind ?? null,
    attempt: opts.attempt ?? 1,
    createdAt: opts.createdAt ?? isoAgo(HOUR_MS),
  })
}

/**
 * Returns the new topic id: the blocked-job remedy lines name the topic a
 * blocked job still holds, so those tests need the id the row got.
 */
export function seedTopic(
  db: Database,
  opts: {
    dedupeHash: string
    channel?: string
    status?: 'candidate' | 'claimed' | 'used' | 'rejected'
    createdAt?: string
    jobId?: string
  },
): number {
  return kit.seedTopic(db, {
    channel: opts.channel ?? 'chan-a',
    title: 'digest topic',
    rawTitle: 'raw',
    source: 'reddit:r/space',
    url: 'https://example.com',
    dedupeHash: opts.dedupeHash,
    score: 70,
    reason: 'test',
    status: opts.status ?? 'candidate',
    createdAt: opts.createdAt ?? isoAgo(HOUR_MS),
    jobId: opts.jobId ?? null,
  })
}

/**
 * The runner stamps started_at when a stage begins; the zombie check ages a
 * running job by the latest such stamp, so tests control it directly.
 */
export function seedStage(db: Database, jobId: string, stage: string, startedAt: string): void {
  kit.seedStage(db, jobId, stage, { status: 'running', startedAt })
}

export function seedCost(db: Database, jobId: string, usdMicros: number): void {
  kit.seedCost(db, jobId, { provider: 'fal', operation: 'video', usdMicros })
}

/** A channel that declares youtube as a target platform, which most sections need. */
export function publishChannel(
  name: string,
  overrides: { videosPerDay?: number } = {},
): ChannelConfig {
  return testChannel({
    name,
    videosPerDay: overrides.videosPerDay ?? 2,
    platforms: ['youtube'],
  })
}

/**
 * A channel that both scouts and publishes — the target of the
 * topic-starvation action item. `scout` overrides the source lists so a
 * caller can exercise either the rss/subreddits path or the llm-only
 * (generate_topics, no feeds) path; the default declares one subreddit.
 */
export function scoutingPublishChannel(
  name: string,
  scout: Partial<ChannelConfig['scout']> = {},
): ChannelConfig {
  return {
    ...publishChannel(name),
    scout: { ...DEFAULT_SCOUT, subreddits: ['test'], ...scout },
  }
}
