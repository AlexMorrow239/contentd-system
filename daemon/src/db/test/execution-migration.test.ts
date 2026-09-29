import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Database } from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { openDb } from '../index.js'
import { migrate } from '../migrate.js'
import {
  fileDb,
  memDb,
  seedAction,
  seedCost,
  seedJob,
  seedLibrary,
  seedPost,
  seedStage,
  seedTopic,
} from '../../../testing/db.js'
import { trackDb } from '../../../testing/tmp.js'

const executionColumns: Record<string, string[]> = {
  jobs: [
    'active_attempt_id',
    'recovery_pending',
    'recovery_count',
    'recovery_stage',
    'previous_attempt_id',
    'retry_after',
    'budget_wait_json',
  ],
  job_stages: ['artifact_dir'],
  costs: ['attempt_id'],
  operator_actions: ['owner_token', 'job_id'],
}

function columns(db: Database, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(
    (row) => row.name,
  )
}

function assertExecutionShape(db: Database): void {
  for (const [table, expected] of Object.entries(executionColumns)) {
    expect(columns(db, table)).toEqual(expect.arrayContaining(expected))
  }
  expect(db.prepare('SELECT * FROM execution_attempts').all()).toEqual([])
}

function preservedRows(db: Database) {
  return {
    job: db
      .prepare('SELECT id, channel, tier, topic, status, created_at, finished_at FROM jobs')
      .all(),
    stages: db
      .prepare('SELECT job_id, stage, status, error, started_at, finished_at FROM job_stages')
      .all(),
    posts: db.prepare('SELECT * FROM posts').all(),
    topic: db.prepare('SELECT * FROM topics').all(),
    library: db.prepare('SELECT * FROM library').all(),
    cost: db.prepare('SELECT job_id, provider, operation, usd_micros, created_at FROM costs').all(),
    action: db.prepare('SELECT id, kind, lane, args, status, notice FROM operator_actions').all(),
  }
}

describe('execution schema migration', () => {
  it('initializes a fresh database with nullable ownership and zero recovery counters', () => {
    const db = memDb()
    seedJob(db, 'fresh', { status: 'queued' })
    seedStage(db, 'fresh', 'script', { status: 'pending' })
    seedCost(db, 'fresh', { usdMicros: 123 })
    seedAction(db, { kind: 'jobs.resume', args: '{"jobId":"fresh"}' })
    migrate(db)
    migrate(db)
    assertExecutionShape(db)
    expect(
      db
        .prepare(
          'SELECT active_attempt_id, recovery_pending, recovery_count, recovery_stage, previous_attempt_id, retry_after, budget_wait_json FROM jobs',
        )
        .get(),
    ).toEqual({
      active_attempt_id: null,
      recovery_pending: 0,
      recovery_count: 0,
      recovery_stage: null,
      previous_attempt_id: null,
      retry_after: null,
      budget_wait_json: null,
    })
    expect(db.prepare('SELECT artifact_dir FROM job_stages').get()).toEqual({ artifact_dir: null })
    expect(db.prepare('SELECT attempt_id FROM costs').get()).toEqual({ attempt_id: null })
    expect(db.prepare('SELECT owner_token, job_id FROM operator_actions').get()).toEqual({
      owner_token: null,
      job_id: null,
    })
  })

  it('upgrades an existing database twice without losing legacy jobs, posts, topics, or artifacts', () => {
    const { db, dbPath, root } = fileDb()
    const legacyDir = join(root, 'runs', 'legacy', 'script')
    mkdirSync(legacyDir, { recursive: true })
    const legacyArtifact = join(legacyDir, 'script.json')
    writeFileSync(legacyArtifact, '{"legacy":"preserve these exact bytes"}')
    seedJob(db, 'legacy', {
      channel: 'chan-a',
      status: 'blocked',
      createdAt: '2026-01-01T00:00:00.000Z',
    })
    seedStage(db, 'legacy', 'script', {
      status: 'done',
      startedAt: '2026-01-01T00:01:00.000Z',
      finishedAt: '2026-01-01T00:02:00.000Z',
    })
    seedLibrary(db, 'legacy', {
      videoPath: join(root, 'runs', 'legacy', 'assemble', 'final.mp4'),
      state: 'ready',
    })
    seedPost(db, {
      jobId: 'legacy',
      channel: 'chan-a',
      platform: 'youtube',
      url: 'https://youtu.be/legacy',
      postedAt: '2026-01-01T01:00:00.000Z',
    })
    seedTopic(db, { channel: 'chan-a', status: 'claimed', jobId: 'legacy' })
    seedCost(db, 'legacy', { usdMicros: 456, createdAt: '2026-01-01T00:01:01.000Z' })
    seedAction(db, {
      kind: 'jobs.resume',
      args: '{"jobId":"legacy"}',
      status: 'failed',
      notice: 'Job legacy was created',
    })
    const before = preservedRows(db)
    const artifactBefore = readFileSync(legacyArtifact)

    // Remove precisely the fields this migration introduces. All preceding
    // schema/data remains real, including constraints and older migrations.
    for (const [table, names] of Object.entries(executionColumns)) {
      for (const name of names) db.exec(`ALTER TABLE ${table} DROP COLUMN ${name}`)
    }
    db.exec('DROP TABLE execution_attempts')
    db.close()

    // This exercises production ordering: schema.sql runs BEFORE migrate.
    // New-column indexes in the wrong place would fail this reopen.
    const upgraded = trackDb(openDb(dbPath))
    migrate(upgraded)
    migrate(upgraded)
    assertExecutionShape(upgraded)
    expect(preservedRows(upgraded)).toEqual(before)
    expect(readFileSync(legacyArtifact)).toEqual(artifactBefore)
    expect(
      upgraded.prepare('SELECT artifact_dir FROM job_stages WHERE job_id=?').get('legacy'),
    ).toEqual({ artifact_dir: null })
    expect(
      upgraded
        .prepare('SELECT active_attempt_id, recovery_count, recovery_pending FROM jobs WHERE id=?')
        .get('legacy'),
    ).toEqual({ active_attempt_id: null, recovery_count: 0, recovery_pending: 0 })
    expect(upgraded.prepare('SELECT attempt_id FROM costs').get()).toEqual({ attempt_id: null })
    expect(upgraded.prepare('SELECT owner_token, job_id FROM operator_actions').get()).toEqual({
      owner_token: null,
      job_id: null,
    })
  })

  it('converges a partially applied migration while preserving recorded recovery state', () => {
    const { db, dbPath } = fileDb()
    seedJob(db, 'partial', { status: 'queued' })
    db.prepare('UPDATE jobs SET recovery_count=3, previous_attempt_id=? WHERE id=?').run(
      'old-attempt',
      'partial',
    )
    db.exec('ALTER TABLE jobs DROP COLUMN budget_wait_json')
    db.exec('ALTER TABLE jobs DROP COLUMN retry_after')
    db.exec('ALTER TABLE costs DROP COLUMN attempt_id')
    db.exec('ALTER TABLE operator_actions DROP COLUMN owner_token')
    db.close()
    const upgraded = trackDb(openDb(dbPath))
    migrate(upgraded)
    assertExecutionShape(upgraded)
    expect(
      upgraded
        .prepare(
          'SELECT recovery_count, previous_attempt_id, budget_wait_json, retry_after FROM jobs',
        )
        .get(),
    ).toEqual({
      recovery_count: 3,
      previous_attempt_id: 'old-attempt',
      budget_wait_json: null,
      retry_after: null,
    })
  })
})
