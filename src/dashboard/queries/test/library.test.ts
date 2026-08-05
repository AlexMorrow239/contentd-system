import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Database } from 'better-sqlite3'
import type { QcResult } from '../../../stages/qc.js'
import { countLibraryEntries, libraryChannels, listLibraryEntries } from '../library.js'
import { memDb, seedJob, seedLibrary, seedLibraryObject, seedPost } from '../../../testing/db.js'
import { tmpDir } from '../../../testing/tmp.js'

function seed(): Database {
  const db = memDb()
  seedJob(db, 'j1', { channel: 'space', topic: 'Venus' })
  seedJob(db, 'j2', { channel: 'ocean', tier: 'premium', topic: 'Trench' })
  return db
}

function addLibrary(db: Database, jobId: string, state: string, metadata: string): void {
  seedLibrary(db, jobId, {
    videoPath: `runs/${jobId}/assemble/final.mp4`,
    metadataJson: metadata,
    state,
    createdAt: `2026-07-2${jobId.slice(1)}T00:00:00.000Z`,
  })
}

describe('listLibraryEntries', () => {
  it('joins channel and topic off the owning job', () => {
    const db = seed()
    addLibrary(db, 'j1', 'needs-review', '{}')
    const [entry] = listLibraryEntries(db)
    expect(entry?.channel).toBe('space')
    expect(entry?.topic).toBe('Venus')
    expect(entry?.videoPath).toBe('runs/j1/assemble/final.mp4')
    db.close()
  })

  it('filters by state and channel', () => {
    const db = seed()
    addLibrary(db, 'j1', 'needs-review', '{}')
    addLibrary(db, 'j2', 'ready', '{}')
    expect(listLibraryEntries(db, { state: 'ready' }).map((e) => e.jobId)).toEqual(['j2'])
    expect(listLibraryEntries(db, { channel: 'space' }).map((e) => e.jobId)).toEqual(['j1'])
    db.close()
  })

  it('summarizes a fully passing qc verdict as ok', () => {
    const db = seed()
    seedLibrary(db, 'j1', {
      qcJson: JSON.stringify({
        passed: true,
        checks: [{ name: 'duration-bounds', passed: true, detail: 'duration 30000ms' }],
      }),
    })
    expect(listLibraryEntries(db)[0]?.qc).toEqual({ kind: 'ok' })
    db.close()
  })

  it('surfaces each failing check as a name: detail issue', () => {
    const db = seed()
    // `satisfies QcResult` pins this fixture to the writer's real shape: a
    // rename in stages/qc.ts would otherwise degrade every row to
    // 'unparseable' with no failing test.
    const verdict = {
      passed: false,
      checks: [
        { name: 'resolution', passed: true, detail: '1080x1920' },
        {
          name: 'duration-bounds',
          passed: false,
          detail: 'duration 14200ms; bounds [15000,180000]; voice 14100ms',
        },
        { name: 'has-audio', passed: false, detail: 'no audio stream' },
      ],
    } satisfies QcResult
    seedLibrary(db, 'j1', { state: 'needs-review', qcJson: JSON.stringify(verdict) })
    expect(listLibraryEntries(db)[0]?.qc).toEqual({
      kind: 'issues',
      issues: [
        'duration-bounds: duration 14200ms; bounds [15000,180000]; voice 14100ms',
        'has-audio: no audio stream',
      ],
    })
    db.close()
  })

  it('reports a row with no recorded verdict as absent rather than inventing one', () => {
    // NULL qc_json is every row finalized before the column existed.
    const db = seed()
    seedLibrary(db, 'j1')
    expect(listLibraryEntries(db)[0]?.qc).toEqual({ kind: 'absent' })
    db.close()
  })

  it('degrades one malformed qc verdict without failing the others', () => {
    const db = seed()
    seedLibrary(db, 'j1', { qcJson: 'not json{{' })
    seedLibrary(db, 'j2', { qcJson: JSON.stringify({ passed: true, checks: [] }) })
    const entries = listLibraryEntries(db)
    expect(entries).toHaveLength(2)
    expect(entries.find((e) => e.jobId === 'j1')?.qc).toEqual({ kind: 'unparseable' })
    expect(entries.find((e) => e.jobId === 'j2')?.qc).toEqual({ kind: 'ok' })
    db.close()
  })

  it('treats a verdict missing its checks array as unparseable', () => {
    const db = seed()
    seedLibrary(db, 'j1', { qcJson: JSON.stringify({ passed: true }) })
    expect(listLibraryEntries(db)[0]?.qc).toEqual({ kind: 'unparseable' })
    db.close()
  })

  it('treats a malformed check entry as unparseable rather than inventing an issue', () => {
    const db = seed()
    seedLibrary(db, 'j1', { qcJson: JSON.stringify({ passed: true, checks: [{}] }) })
    expect(listLibraryEntries(db)[0]?.qc).toEqual({ kind: 'unparseable' })
    db.close()
  })

  it('defaults to a 200-row limit, matching listJobs', () => {
    const db = seed()
    addLibrary(db, 'j1', 'ready', '{}')
    addLibrary(db, 'j2', 'ready', '{}')
    expect(listLibraryEntries(db, { limit: 1 })).toHaveLength(1)
    db.close()
  })

  it('reports a reclaimed object as reclaimed', () => {
    const db = memDb()
    seedJob(db, 'job-1', { channel: 'chan-a' })
    seedLibrary(db, 'job-1', { state: 'published', videoPath: '/nope/final.mp4' })
    seedLibraryObject(db, 'job-1', { reclaimedAt: '2026-07-26T00:00:00.000Z' })

    expect(listLibraryEntries(db)[0].bytes).toBe('reclaimed')
  })

  it('reports a stored object with no local file as archived', () => {
    const db = memDb()
    seedJob(db, 'job-1', { channel: 'chan-a' })
    seedLibrary(db, 'job-1', { state: 'published', videoPath: '/nope/final.mp4' })
    seedLibraryObject(db, 'job-1')

    expect(listLibraryEntries(db)[0].bytes).toBe('archived')
  })

  it('reports a video with no library_objects row as unstored, not archived', () => {
    const db = memDb()
    seedJob(db, 'job-1', { channel: 'chan-a' })
    seedLibrary(db, 'job-1', { state: 'ready', videoPath: '/nope/final.mp4' })
    // No seedLibraryObject call: this job was never uploaded to object storage.

    expect(listLibraryEntries(db)[0].bytes).toBe('unstored')
  })

  it('reports an existing local file as local', () => {
    const db = memDb()
    const dir = tmpDir('lib')
    const videoPath = join(dir, 'final.mp4')
    writeFileSync(videoPath, 'video')
    seedJob(db, 'job-1', { channel: 'chan-a' })
    seedLibrary(db, 'job-1', { state: 'published', videoPath })

    expect(listLibraryEntries(db)[0].bytes).toBe('local')
  })

  it('lists one link per platform that posted, ordered by job id then platform', () => {
    const db = memDb()
    seedJob(db, 'job-1', { channel: 'chan-a' })
    seedLibrary(db, 'job-1', { state: 'ready' })
    seedPost(db, {
      jobId: 'job-1',
      platform: 'youtube',
      channel: 'chan-a',
      url: 'https://youtu.be/abc',
    })
    seedPost(db, {
      jobId: 'job-1',
      platform: 'instagram',
      channel: 'chan-a',
      url: 'https://instagram.com/reel/xyz',
    })

    expect(listLibraryEntries(db)[0].links).toEqual([
      { platform: 'instagram', url: 'https://instagram.com/reel/xyz' },
      { platform: 'youtube', url: 'https://youtu.be/abc' },
    ])
  })

  it('omits a post with no url', () => {
    const db = memDb()
    seedJob(db, 'job-1', { channel: 'chan-a' })
    seedLibrary(db, 'job-1', { state: 'ready' })
    seedPost(db, { jobId: 'job-1', platform: 'instagram', channel: 'chan-a', url: null })

    expect(listLibraryEntries(db)[0].links).toEqual([])
  })
})

describe('libraryChannels', () => {
  it('lists distinct channels alphabetically', () => {
    const db = seed()
    addLibrary(db, 'j1', 'ready', '{}')
    addLibrary(db, 'j2', 'ready', '{}')
    expect(libraryChannels(db)).toEqual(['ocean', 'space'])
    db.close()
  })
})

describe('countLibraryEntries', () => {
  it('counts all matching rows regardless of any limit applied elsewhere', () => {
    const db = seed()
    addLibrary(db, 'j1', 'ready', '{}')
    addLibrary(db, 'j2', 'needs-review', '{}')
    expect(countLibraryEntries(db)).toBe(2)
    db.close()
  })

  it('applies the same state and channel filters as listLibraryEntries', () => {
    const db = seed()
    addLibrary(db, 'j1', 'ready', '{}')
    addLibrary(db, 'j2', 'needs-review', '{}')
    expect(countLibraryEntries(db, { state: 'ready' })).toBe(1)
    expect(countLibraryEntries(db, { channel: 'ocean' })).toBe(1)
    db.close()
  })
})
