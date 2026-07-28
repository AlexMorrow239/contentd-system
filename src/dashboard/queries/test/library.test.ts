import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Database } from 'better-sqlite3'
import { countLibraryEntries, libraryChannels, listLibraryEntries } from '../library.js'
import { memDb, seedJob, seedLibrary, seedLibraryObject, seedPublish } from '../../../testing/db.js'
import { tmpDir } from '../../../testing/tmp.js'

function seed(): Database {
  const db = memDb()
  db.prepare(
    "INSERT INTO jobs (id, channel, tier, topic, status) VALUES ('j1','space','volume','Venus','done')",
  ).run()
  db.prepare(
    "INSERT INTO jobs (id, channel, tier, topic, status) VALUES ('j2','ocean','premium','Trench','done')",
  ).run()
  return db
}

function addLibrary(db: Database, jobId: string, state: string, metadata: string): void {
  db.prepare(
    'INSERT INTO library (job_id, video_path, metadata_json, state, created_at) VALUES (?, ?, ?, ?, ?)',
  ).run(
    jobId,
    `runs/${jobId}/assemble/final.mp4`,
    metadata,
    state,
    `2026-07-2${jobId.slice(1)}T00:00:00.000Z`,
  )
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

  it('summarizes a qc block with no issues as ok', () => {
    const db = seed()
    addLibrary(db, 'j1', 'ready', JSON.stringify({ qc: { issues: [] } }))
    expect(listLibraryEntries(db)[0]?.qc).toEqual({ kind: 'ok' })
    db.close()
  })

  it('surfaces qc issues', () => {
    const db = seed()
    addLibrary(db, 'j1', 'needs-review', JSON.stringify({ qc: { issues: ['duration 71s > 60s'] } }))
    expect(listLibraryEntries(db)[0]?.qc).toEqual({
      kind: 'issues',
      issues: ['duration 71s > 60s'],
    })
    db.close()
  })

  it('reports absent qc rather than inventing a verdict', () => {
    const db = seed()
    addLibrary(db, 'j1', 'ready', '{}')
    expect(listLibraryEntries(db)[0]?.qc).toEqual({ kind: 'absent' })
    db.close()
  })

  it('degrades one malformed metadata row without failing the others', () => {
    const db = seed()
    addLibrary(db, 'j1', 'ready', 'not json{{')
    addLibrary(db, 'j2', 'ready', JSON.stringify({ qc: { issues: [] } }))
    const entries = listLibraryEntries(db)
    expect(entries).toHaveLength(2)
    expect(entries.find((e) => e.jobId === 'j1')?.qc).toEqual({ kind: 'unparseable' })
    expect(entries.find((e) => e.jobId === 'j2')?.qc).toEqual({ kind: 'ok' })
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

  it('reports an existing local file as local', () => {
    const db = memDb()
    const dir = tmpDir('lib')
    const videoPath = join(dir, 'final.mp4')
    writeFileSync(videoPath, 'video')
    seedJob(db, 'job-1', { channel: 'chan-a' })
    seedLibrary(db, 'job-1', { state: 'published', videoPath })

    expect(listLibraryEntries(db)[0].bytes).toBe('local')
  })

  it('lists one link per platform that published, newest first', () => {
    const db = memDb()
    seedJob(db, 'job-1', { channel: 'chan-a' })
    seedLibrary(db, 'job-1', { state: 'published' })
    seedPublish(db, 'job-1', {
      platform: 'youtube',
      channel: 'chan-a',
      status: 'done',
      seq: 1,
      url: 'https://youtu.be/abc',
    })
    seedPublish(db, 'job-1', {
      platform: 'instagram',
      channel: 'chan-a',
      status: 'done',
      seq: 2,
      url: 'https://instagram.com/reel/xyz',
    })

    expect(listLibraryEntries(db)[0].links).toEqual([
      { platform: 'instagram', url: 'https://instagram.com/reel/xyz' },
      { platform: 'youtube', url: 'https://youtu.be/abc' },
    ])
  })

  it('omits a failed publish and a done row with no url', () => {
    const db = memDb()
    seedJob(db, 'job-1', { channel: 'chan-a' })
    seedLibrary(db, 'job-1', { state: 'ready' })
    seedPublish(db, 'job-1', { platform: 'youtube', channel: 'chan-a', status: 'failed', errorKind: 'transient', seq: 1 })
    seedPublish(db, 'job-1', { platform: 'instagram', channel: 'chan-a', status: 'done', seq: 2, url: null })

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
