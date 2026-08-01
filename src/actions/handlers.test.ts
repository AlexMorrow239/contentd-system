import { describe, expect, it } from 'vitest'
import type { Database } from 'better-sqlite3'
import { BrainrotError } from '../errors.js'
import { memDb, seedJob, seedLibrary, seedPublish, seedTopic } from '../testing/db.js'
import { ACTION_KINDS } from './catalog.js'
import { ACTION_HANDLERS, runAction, type ActionContext } from './handlers.js'

function ctx(db: Database): ActionContext {
  return {
    db,
    now: new Date('2026-08-01T10:00:00Z'),
    channelsDir: '/nonexistent/channels',
    runsRoot: '/nonexistent/runs',
    setNotice: () => {},
  }
}

describe('action handlers', () => {
  it('has exactly one handler per catalog entry', () => {
    // The anti-drift guard: a catalog entry with no handler would enqueue
    // fine and then fail in the worker, minutes later, with a confusing error.
    expect(Object.keys(ACTION_HANDLERS).sort()).toEqual([...ACTION_KINDS].sort())
  })

  it('rejects candidate topics and reports how many changed', async () => {
    const db = memDb()
    const a = seedTopic(db, { title: 'one' })
    const b = seedTopic(db, { title: 'two', status: 'used' })
    const result = await runAction(ctx(db), 'topics.reject', { ids: [String(a), String(b)] })
    expect(result).toEqual({ rejected: 1, requested: 2 })
  })

  it('validates args before touching the database', async () => {
    const db = memDb()
    await expect(runAction(ctx(db), 'topics.reject', { ids: [] })).rejects.toThrow(BrainrotError)
  })

  it('requeues a claimed topic', async () => {
    const db = memDb()
    const id = seedTopic(db, { status: 'claimed', jobId: null })
    expect(await runAction(ctx(db), 'topics.requeue', { id: String(id) })).toEqual({ ok: true })
  })

  it('surfaces a refused requeue as a failure, not a silent success', async () => {
    // A candidate topic is not claimed; the CLI reports this and exits 1, so
    // the action must fail rather than record ok.
    const db = memDb()
    const id = seedTopic(db, { status: 'candidate' })
    await expect(runAction(ctx(db), 'topics.requeue', { id: String(id) })).rejects.toThrow(
      /not-claimed/,
    )
  })

  it('approves needs-review library rows and reports reclaimed refusals', async () => {
    const db = memDb()
    seedJob(db, 'j1')
    seedLibrary(db, 'j1', { state: 'needs-review' })
    expect(await runAction(ctx(db), 'library.approve', { jobIds: 'j1' })).toEqual({
      approved: 1,
      requested: 1,
      reclaimed: [],
    })
  })

  it('clears an interrupted publish', async () => {
    const db = memDb()
    seedJob(db, 'j1')
    seedPublish(db, 'j1', { status: 'interrupted' })
    expect(await runAction(ctx(db), 'publish.retry', { jobId: 'j1' })).toEqual({ cleared: true })
  })

  it('fails a retry when the job has no interrupted publish', async () => {
    const db = memDb()
    seedJob(db, 'j1')
    await expect(runAction(ctx(db), 'publish.retry', { jobId: 'j1' })).rejects.toThrow(
      /no interrupted publish/,
    )
  })

  it('marks an interrupted publish done and derives the url from its own platform', async () => {
    const db = memDb()
    seedJob(db, 'j1')
    seedPublish(db, 'j1', { status: 'interrupted', platform: 'youtube' })
    const result = (await runAction(ctx(db), 'publish.markDone', {
      jobId: 'j1',
      postId: 'abc123',
    })) as { url: string | null }
    // The interrupted row names the platform, so no --platform arg exists to
    // get wrong — and a Shorts url can never be recorded against an IG media id.
    expect(result.url).toContain('abc123')
  })

  it('returns the digest text', async () => {
    const db = memDb()
    const result = (await runAction(ctx(db), 'digest.run', {})) as { text: string }
    expect(typeof result.text).toBe('string')
    expect(result.text.length).toBeGreaterThan(0)
  })
})
