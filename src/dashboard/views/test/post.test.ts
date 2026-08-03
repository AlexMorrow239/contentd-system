import { describe, expect, it } from 'vitest'
import type { PostCard, PostCardPlatform } from '../../queries/post.js'
import { renderPostQueuePage, type PostPageData } from '../post.js'

function platform(overrides: Partial<PostCardPlatform> = {}): PostCardPlatform {
  return {
    platform: 'youtube',
    posted: false,
    url: null,
    title: 'a title',
    body: 'a body',
    tags: 'a, b',
    ...overrides,
  }
}

function card(overrides: Partial<PostCard> = {}): PostCard {
  return {
    jobId: 'job-1',
    channel: 'alpha',
    topic: 'a topic',
    createdAt: '2026-07-26T00:00:00.000Z',
    bytes: 'local',
    seriesLabel: null,
    platforms: [platform()],
    ...overrides,
  }
}

function pageData(cards: PostCard[]): PostPageData {
  return { cards, csrfToken: 'tok', daemonStale: false }
}

describe('renderPostQueuePage', () => {
  it('embeds a player pointing at the streaming route when bytes are local', () => {
    const out = renderPostQueuePage(pageData([card({ jobId: 'j1', bytes: 'local' })])).value
    expect(out).toContain('src="/library/j1/video"')
  })

  it('renders a plain state label instead of a player when bytes are not local', () => {
    const out = renderPostQueuePage(pageData([card({ bytes: 'archived' })])).value
    expect(out).not.toContain('<video')
    expect(out).toContain('archived')
  })

  it('renders the reclaimed state label', () => {
    const out = renderPostQueuePage(pageData([card({ bytes: 'reclaimed' })])).value
    expect(out).not.toContain('<video')
    expect(out).toContain('reclaimed')
  })

  it('renders the unstored state label, naming the fix', () => {
    const out = renderPostQueuePage(pageData([card({ bytes: 'unstored' })])).value
    expect(out).not.toContain('<video')
    expect(out).toContain('library backfill-store')
  })

  it('renders an unposted platform as a post.mark form with jobId, platform and url', () => {
    const out = renderPostQueuePage(
      pageData([
        card({ jobId: 'j1', platforms: [platform({ platform: 'youtube', posted: false })] }),
      ]),
    ).value
    expect(out).toContain('name="kind" value="post.mark"')
    expect(out).toContain('name="csrf" value="tok"')
    expect(out).toContain('name="jobId" value="j1"')
    expect(out).toContain('name="platform" value="youtube"')
    expect(out).toContain('name="url"')
  })

  it('renders a posted platform with its link and an unmark control', () => {
    const out = renderPostQueuePage(
      pageData([
        card({
          jobId: 'j1',
          platforms: [platform({ platform: 'youtube', posted: true, url: 'https://youtu.be/abc' })],
        }),
      ]),
    ).value
    expect(out).toContain('href="https://youtu.be/abc"')
    expect(out).toContain('post.unmark')
  })

  it('escapes a hostile topic title', () => {
    const out = renderPostQueuePage(pageData([card({ topic: '<script>alert(1)</script>' })])).value
    expect(out).not.toContain('<script>alert(1)</script>')
  })

  it('renders the series badge when present', () => {
    const out = renderPostQueuePage(pageData([card({ seriesLabel: 'part 2/4' })])).value
    expect(out).toContain('part 2/4')
  })

  it('renders no series badge when absent', () => {
    const out = renderPostQueuePage(pageData([card({ seriesLabel: null })])).value
    expect(out).not.toContain('part ')
  })

  it('reports an empty queue plainly', () => {
    const out = renderPostQueuePage(pageData([])).value
    expect(out).toContain('nothing waiting to post')
  })

  it('offers a discard (library.reject) control on the card', () => {
    // confirm:true, so this renders as a link to the confirm interstitial
    // rather than a direct form — same shape as post.unmark above.
    const out = renderPostQueuePage(pageData([card({ jobId: 'j1' })])).value
    expect(out).toContain('kind=library.reject')
    expect(out).toContain('jobIds=j1')
  })
})
