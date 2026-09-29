import { describe, expect, it } from 'vitest'
import { limitBodies } from './prompt.js'

describe('limitBodies', () => {
  it('shares capacity equally between long sources and marks each truncation', () => {
    const result = limitBodies('post '.repeat(10_000), 'article '.repeat(10_000))
    expect(result.post.length).toBeLessThanOrEqual(30_000)
    expect(result.article.length).toBeLessThanOrEqual(30_000)
    expect(result.postTruncated).toBe(true)
    expect(result.articleTruncated).toBe(true)
    expect(result.article.trim().endsWith('article')).toBe(true)
  })

  it('gives unused space to the longer source', () => {
    const result = limitBodies('Short post.', 'article '.repeat(10_000))
    expect(result.post).toBe('Short post.')
    expect(result.postTruncated).toBe(false)
    expect(result.article.length).toBeGreaterThan(59_000)
    expect(result.post.length + result.article.length).toBeLessThanOrEqual(60_000)
  })

  it('preserves both complete sources when they fit', () => {
    expect(limitBodies('First\n\nSecond', 'Full article.')).toEqual({
      post: 'First\n\nSecond',
      article: 'Full article.',
      postTruncated: false,
      articleTruncated: false,
    })
  })
})
