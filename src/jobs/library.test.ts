import { describe, expect, it } from 'vitest'
import { execa } from 'execa'
import type { Database } from 'better-sqlite3'
import { openDb } from '../db/index.js'
import { parseLibraryJobIds } from '../cli.js'
import { approveLibrary, listLibrary, rejectLibrary } from './library.js'
import type { LibraryState } from './library.js'

// Raw-insert seed: the DAO only ever writes library.state, so tests control
// every other column — the owning jobs row included — directly.
let seq = 0

function seedJob(
  db: Database,
  overrides: Partial<{ id: string; channel: string; tier: string; topic: string }> = {},
): string {
  seq += 1
  const row = {
    id: `job-${seq}`,
    channel: 'chan-a',
    tier: 'volume',
    topic: `Topic ${seq}`,
    ...overrides,
  }
  db.prepare('INSERT INTO jobs (id, channel, tier, topic, status) VALUES (?, ?, ?, ?, ?)').run(
    row.id,
    row.channel,
    row.tier,
    row.topic,
    'done',
  )
  return row.id
}

function seedLibrary(
  db: Database,
  jobId: string,
  overrides: Partial<{
    videoPath: string
    metadataJson: string
    state: LibraryState
    createdAt: string
  }> = {},
): void {
  const row = {
    videoPath: `runs/${jobId}/final.mp4`,
    metadataJson: '{}',
    state: 'needs-review' as LibraryState,
    createdAt: '2026-07-20T00:00:00.000Z',
    ...overrides,
  }
  db.prepare(
    'INSERT INTO library (job_id, video_path, metadata_json, state, created_at) VALUES (?, ?, ?, ?, ?)',
  ).run(jobId, row.videoPath, row.metadataJson, row.state, row.createdAt)
}

describe('listLibrary', () => {
  it('joins jobs for channel/topic and returns newest created_at first', () => {
    const db = openDb(':memory:')
    seedLibrary(db, seedJob(db, { id: 'j-old', topic: 'old topic' }), {
      createdAt: '2026-07-19T00:00:00.000Z',
    })
    seedLibrary(
      db,
      seedJob(db, { id: 'j-new', channel: 'chan-b', topic: 'deep sea trivia' }),
      { videoPath: 'runs/j-new/final.mp4', state: 'ready', createdAt: '2026-07-20T00:00:00.000Z' },
    )
    const rows = listLibrary(db)
    expect(rows.map((r) => r.jobId)).toEqual(['j-new', 'j-old'])
    expect(rows[0]).toEqual({
      jobId: 'j-new',
      channel: 'chan-b',
      topic: 'deep sea trivia',
      videoPath: 'runs/j-new/final.mp4',
      state: 'ready',
      createdAt: '2026-07-20T00:00:00.000Z',
    })
    db.close()
  })

  it('filters by state and channel independently', () => {
    const db = openDb(':memory:')
    seedLibrary(db, seedJob(db, { channel: 'chan-a' }), { state: 'ready' })
    seedLibrary(db, seedJob(db, { channel: 'chan-a' }), { state: 'blocked' })
    seedLibrary(db, seedJob(db, { channel: 'chan-b' }), { state: 'ready' })
    expect(listLibrary(db, { channel: 'chan-a' })).toHaveLength(2)
    expect(listLibrary(db, { state: 'ready' })).toHaveLength(2)
    expect(listLibrary(db, { channel: 'chan-a', state: 'ready' })).toHaveLength(1)
    expect(listLibrary(db, { channel: 'chan-b', state: 'blocked' })).toEqual([])
    db.close()
  })
})

describe('approveLibrary', () => {
  it('flips needs-review rows to ready and reports the changed count; other ids are skipped', () => {
    const db = openDb(':memory:')
    const a = seedJob(db, { id: 'a' }) // needs-review
    seedLibrary(db, a, { state: 'needs-review' })
    const b = seedJob(db, { id: 'b' })
    seedLibrary(db, b, { state: 'ready' })
    const c = seedJob(db, { id: 'c' }) // needs-review
    seedLibrary(db, c, { state: 'needs-review' })

    // b is not needs-review and 'no-such-job' does not exist: both silently skipped
    expect(approveLibrary(db, [a, b, c, 'no-such-job'])).toBe(2)
    const states = db.prepare('SELECT job_id, state FROM library ORDER BY job_id').all() as {
      job_id: string
      state: string
    }[]
    expect(states).toEqual([
      { job_id: 'a', state: 'ready' },
      { job_id: 'b', state: 'ready' },
      { job_id: 'c', state: 'ready' },
    ])
    db.close()
  })

  it('returns 0 when no id is in needs-review state (or the batch is empty)', () => {
    const db = openDb(':memory:')
    const ready = seedJob(db, { id: 'ready-job' })
    seedLibrary(db, ready, { state: 'ready' })
    const blocked = seedJob(db, { id: 'blocked-job' })
    seedLibrary(db, blocked, { state: 'blocked' })
    const published = seedJob(db, { id: 'published-job' })
    seedLibrary(db, published, { state: 'published' })

    expect(approveLibrary(db, ['ready-job', 'blocked-job', 'published-job'])).toBe(0)
    expect(approveLibrary(db, [])).toBe(0)
    db.close()
  })
})

describe('rejectLibrary', () => {
  it('flips needs-review and ready rows to blocked; published and unknown ids are skipped', () => {
    const db = openDb(':memory:')
    const a = seedJob(db, { id: 'a' })
    seedLibrary(db, a, { state: 'needs-review' })
    const b = seedJob(db, { id: 'b' })
    seedLibrary(db, b, { state: 'ready' })
    const c = seedJob(db, { id: 'c' })
    seedLibrary(db, c, { state: 'published' })

    // c is published (immutable history) and 'no-such-job' does not exist: both skipped
    expect(rejectLibrary(db, [a, b, c, 'no-such-job'])).toBe(2)
    const states = db.prepare('SELECT job_id, state FROM library ORDER BY job_id').all() as {
      job_id: string
      state: string
    }[]
    expect(states).toEqual([
      { job_id: 'a', state: 'blocked' },
      { job_id: 'b', state: 'blocked' },
      { job_id: 'c', state: 'published' },
    ])
    expect(rejectLibrary(db, [])).toBe(0)
    db.close()
  })
})

describe('parseLibraryJobIds (in-process)', () => {
  it('passes non-empty tokens through unchanged, in order', () => {
    expect(parseLibraryJobIds(['V1StGXR8', 'abc123_-Z'])).toEqual(['V1StGXR8', 'abc123_-Z'])
    // commander's <jobIds...> guarantees at least one token, but the helper
    // itself is total: an empty list is an empty result, not an error.
    expect(parseLibraryJobIds([])).toEqual([])
  })

  it('throws naming the first empty/whitespace-only token', () => {
    expect(() => parseLibraryJobIds([''])).toThrow(
      'invalid job id "": ids must not be empty or whitespace',
    )
    expect(() => parseLibraryJobIds(['   '])).toThrow('invalid job id "   "')
    // the FIRST offender is the one named, even when later tokens are also bad
    expect(() => parseLibraryJobIds(['j1', '', 'j2'])).toThrow('invalid job id ""')
  })
})

describe('library CLI', () => {
  it('`library --help` lists the list/approve/reject subcommands', async () => {
    const result = await execa('pnpm', ['exec', 'tsx', 'src/cli.ts', 'library', '--help'], {
      reject: false,
    })
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('list')
    expect(result.stdout).toContain('approve')
    expect(result.stdout).toContain('reject')
  }, 60000)
})
