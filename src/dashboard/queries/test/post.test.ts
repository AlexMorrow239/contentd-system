import { describe, expect, it } from 'vitest'
import { memDb, seedJob, seedLibrary, seedPost, seedTopic } from '../../../testing/db.js'
import { testChannel } from '../../../testing/channel.js'
import { listPostQueue } from '../post.js'

describe('listPostQueue', () => {
  const alpha = testChannel({ name: 'alpha', platforms: ['youtube', 'tiktok'] })

  function seedReady(db: ReturnType<typeof memDb>, jobId: string, createdAt: string): void {
    seedJob(db, jobId, { channel: 'alpha', topic: `topic ${jobId}` })
    seedLibrary(db, jobId, {
      state: 'ready',
      createdAt,
      metadataJson: JSON.stringify({
        youtube: { title: 'YT title', description: 'YT body', hashtags: ['#a'] },
        tiktok: { title: 'TT title', description: 'TT body', hashtags: ['#b'] },
      }),
    })
  }

  it('lists ready videos oldest first', () => {
    const db = memDb()
    seedReady(db, 'j2', '2026-02-01T00:00:00.000Z')
    seedReady(db, 'j1', '2026-01-01T00:00:00.000Z')
    expect(listPostQueue(db, [alpha]).map((c) => c.jobId)).toEqual(['j1', 'j2'])
  })

  it('drops a card once every declared platform is posted', () => {
    const db = memDb()
    seedReady(db, 'j1', '2026-01-01T00:00:00.000Z')
    seedPost(db, { jobId: 'j1', channel: 'alpha', platform: 'youtube' })
    expect(listPostQueue(db, [alpha])).toHaveLength(1)
    seedPost(db, { jobId: 'j1', channel: 'alpha', platform: 'tiktok' })
    expect(listPostQueue(db, [alpha])).toHaveLength(0)
  })

  it('marks the posted platform and carries its url', () => {
    const db = memDb()
    seedReady(db, 'j1', '2026-01-01T00:00:00.000Z')
    seedPost(db, { jobId: 'j1', channel: 'alpha', platform: 'youtube', url: 'https://y/1' })
    const [card] = listPostQueue(db, [alpha])
    expect(card?.platforms).toEqual([
      expect.objectContaining({ platform: 'youtube', posted: true, url: 'https://y/1' }),
      expect.objectContaining({ platform: 'tiktok', posted: false, url: null }),
    ])
  })

  it('excludes needs-review videos — approval comes first', () => {
    const db = memDb()
    seedJob(db, 'j1', { channel: 'alpha' })
    seedLibrary(db, 'j1', { state: 'needs-review' })
    expect(listPostQueue(db, [alpha])).toEqual([])
  })

  it('excludes discarded videos', () => {
    const db = memDb()
    seedJob(db, 'j1', { channel: 'alpha' })
    seedLibrary(db, 'j1', { state: 'blocked' })
    expect(listPostQueue(db, [alpha])).toEqual([])
  })

  it('excludes channels that declare no platforms', () => {
    const db = memDb()
    seedReady(db, 'j1', '2026-01-01T00:00:00.000Z')
    expect(listPostQueue(db, [testChannel({ name: 'alpha', platforms: [] })])).toEqual([])
  })

  // YouTube gets a separate title field; the others compose it into the caption.
  it('renders per-platform paste bodies through the normalizers', () => {
    const db = memDb()
    seedReady(db, 'j1', '2026-01-01T00:00:00.000Z')
    const [card] = listPostQueue(db, [alpha])
    const yt = card?.platforms.find((p) => p.platform === 'youtube')
    expect(yt?.title).toBe('YT title')
    expect(yt?.body).toBe('YT body\n\n#a')
    expect(yt?.tags).toBe('a')
    const tt = card?.platforms.find((p) => p.platform === 'tiktok')
    expect(tt?.title).toBeNull()
    expect(tt?.body).toBe('TT title\n\nTT body\n\n#b')
  })

  it('labels a story continuation', () => {
    const db = memDb()
    seedReady(db, 'j1', '2026-01-01T00:00:00.000Z')
    seedTopic(db, { jobId: 'j1', seriesKey: 's1', partIndex: 2, partCount: 4 })
    expect(listPostQueue(db, [alpha])[0]?.seriesLabel).toBe('part 2/4')
  })
})
