import { describe, expect, it } from 'vitest'
import type { Database } from 'better-sqlite3'
import { openDb } from '../../db/index.js'
import { libraryChannels, listLibraryEntries } from './library.js'

function seed(): Database {
  const db = openDb(':memory:')
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
  ).run(jobId, `runs/${jobId}/assemble/final.mp4`, metadata, state, `2026-07-2${jobId.slice(1)}T00:00:00.000Z`)
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
