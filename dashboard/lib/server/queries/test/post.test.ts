import { describe, expect, it } from 'vitest'
import { memDb, seedJob, seedLibrary, seedPost, seedTopic } from '../../../../../src/testing/db.js'
import { testChannel } from '../../../../../src/testing/channel.js'
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

  it('reports missing bytes when the local video does not exist', () => {
    const db = memDb()
    seedReady(db, 'j1', '2026-01-01T00:00:00.000Z')
    expect(listPostQueue(db, [alpha])[0]?.bytes).toBe('missing')
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

  // One read across every channel, so each channel's own declared-platform set
  // has to survive being OR'd in beside the others': a shared clause would let
  // beta's single platform decide when an alpha card is fully posted.
  it('interleaves channels oldest-first, each against its own declared platforms', () => {
    const db = memDb()
    const beta = testChannel({ name: 'beta', platforms: ['youtube'] })
    seedReady(db, 'a-old', '2026-01-01T00:00:00.000Z')
    seedReady(db, 'a-new', '2026-03-01T00:00:00.000Z')
    seedJob(db, 'b-mid', { channel: 'beta', topic: 'topic b-mid' })
    seedLibrary(db, 'b-mid', { state: 'ready', createdAt: '2026-02-01T00:00:00.000Z' })

    expect(listPostQueue(db, [alpha, beta]).map((c) => c.jobId)).toEqual([
      'a-old',
      'b-mid',
      'a-new',
    ])

    // One youtube post consumes beta's whole checklist but only half alpha's.
    seedPost(db, { jobId: 'b-mid', channel: 'beta', platform: 'youtube' })
    seedPost(db, { jobId: 'a-old', channel: 'alpha', platform: 'youtube' })
    expect(listPostQueue(db, [alpha, beta]).map((c) => c.jobId)).toEqual(['a-old', 'a-new'])
  })

  it('caps the page, not each channel, at the limit', () => {
    const db = memDb()
    const beta = testChannel({ name: 'beta', platforms: ['youtube'] })
    seedReady(db, 'a1', '2026-01-01T00:00:00.000Z')
    seedJob(db, 'b1', { channel: 'beta', topic: 'topic b1' })
    seedLibrary(db, 'b1', { state: 'ready', createdAt: '2026-02-01T00:00:00.000Z' })
    expect(listPostQueue(db, [alpha, beta], { limit: 1 }).map((c) => c.jobId)).toEqual(['a1'])
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

  it('labels nothing for a single-part video', () => {
    const db = memDb()
    seedReady(db, 'j1', '2026-01-01T00:00:00.000Z')
    seedTopic(db, { jobId: 'j1', seriesKey: 's1', partIndex: 1, partCount: 1 })
    expect(listPostQueue(db, [alpha])[0]?.seriesLabel).toBeNull()
  })

  it('renders an Instagram caption and caps its hashtags at 30', () => {
    const db = memDb()
    const igChannel = testChannel({ name: 'ig', platforms: ['instagram'] })
    seedJob(db, 'j1', { channel: 'ig', topic: 'topic j1' })
    const hashtags = Array.from({ length: 40 }, (_, i) => `#tag${i}`)
    seedLibrary(db, 'j1', {
      state: 'ready',
      createdAt: '2026-01-01T00:00:00.000Z',
      metadataJson: JSON.stringify({
        instagram: { title: 'IG title', description: 'IG body', hashtags },
      }),
    })
    const [card] = listPostQueue(db, [igChannel])
    const ig = card?.platforms.find((p) => p.platform === 'instagram')
    expect(ig?.title).toBeNull()
    expect(ig?.body.startsWith('IG title\n\nIG body\n\n')).toBe(true)
    const tagsInBody = ig?.body.match(/#tag\d+/g) ?? []
    expect(tagsInBody.length).toBeLessThanOrEqual(30)
  })

  describe('malformed metadata containment', () => {
    it('contains unparseable JSON to one card, leaving a neighbour intact', () => {
      const db = memDb()
      seedJob(db, 'bad', { channel: 'alpha', topic: 'bad topic' })
      seedLibrary(db, 'bad', {
        state: 'ready',
        createdAt: '2026-01-01T00:00:00.000Z',
        metadataJson: '{not json',
      })
      seedReady(db, 'good', '2026-01-02T00:00:00.000Z')

      const cards = listPostQueue(db, [alpha])
      expect(cards).toHaveLength(2)

      const badCard = cards.find((c) => c.jobId === 'bad')
      expect(badCard?.platforms).toEqual([
        expect.objectContaining({ platform: 'youtube', title: null, body: '', tags: null }),
        expect.objectContaining({ platform: 'tiktok', title: null, body: '', tags: null }),
      ])

      const goodCard = cards.find((c) => c.jobId === 'good')
      const yt = goodCard?.platforms.find((p) => p.platform === 'youtube')
      expect(yt?.title).toBe('YT title')
      expect(yt?.body).toBe('YT body\n\n#a')
    })

    it('contains a wrong-shape platform entry to that platform, leaving others on the card intact', () => {
      const db = memDb()
      seedJob(db, 'j1', { channel: 'alpha', topic: 'topic j1' })
      seedLibrary(db, 'j1', {
        state: 'ready',
        createdAt: '2026-01-01T00:00:00.000Z',
        metadataJson: JSON.stringify({
          youtube: { title: 123, description: 'YT body', hashtags: ['#a'] },
          tiktok: { title: 'TT title', description: 'TT body', hashtags: ['#b'] },
        }),
      })
      const [card] = listPostQueue(db, [alpha])
      const yt = card?.platforms.find((p) => p.platform === 'youtube')
      expect(yt).toEqual(
        expect.objectContaining({ platform: 'youtube', title: null, body: '', tags: null }),
      )
      const tt = card?.platforms.find((p) => p.platform === 'tiktok')
      expect(tt?.body).toBe('TT title\n\nTT body\n\n#b')
    })

    it('contains a platform declared by the channel but absent from the metadata', () => {
      const db = memDb()
      seedJob(db, 'j1', { channel: 'alpha', topic: 'topic j1' })
      seedLibrary(db, 'j1', {
        state: 'ready',
        createdAt: '2026-01-01T00:00:00.000Z',
        metadataJson: JSON.stringify({
          youtube: { title: 'YT title', description: 'YT body', hashtags: ['#a'] },
          // tiktok entirely absent
        }),
      })
      const [card] = listPostQueue(db, [alpha])
      const yt = card?.platforms.find((p) => p.platform === 'youtube')
      expect(yt?.title).toBe('YT title')
      const tt = card?.platforms.find((p) => p.platform === 'tiktok')
      expect(tt).toEqual(
        expect.objectContaining({ platform: 'tiktok', title: null, body: '', tags: null }),
      )
    })
  })
})
