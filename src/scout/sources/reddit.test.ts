import { describe, expect, it } from 'vitest'
import { SOURCE_FETCH_TIMEOUT_MS, dedupeHash } from './types.js'

describe('dedupeHash', () => {
  it('is the sha256 hex of sourceId + newline + externalId', () => {
    // printf 'reddit:r/space\nt3_abc' | shasum -a 256
    expect(dedupeHash('reddit:r/space', 't3_abc')).toBe(
      '543177266c3fc519b4f49513548b8109762f1e86010a941570d86885ac5b0f0a',
    )
  })

  it('is stable across calls, distinct across items, and lowercase hex', () => {
    expect(dedupeHash('rss:example.com', 'guid-1')).toBe(dedupeHash('rss:example.com', 'guid-1'))
    expect(dedupeHash('rss:example.com', 'guid-1')).not.toBe(
      dedupeHash('rss:example.com', 'guid-2'),
    )
    expect(dedupeHash('rss:example.com', 'guid-1')).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe('SOURCE_FETCH_TIMEOUT_MS', () => {
  it('defaults to 10 seconds', () => {
    expect(SOURCE_FETCH_TIMEOUT_MS).toBe(10_000)
  })
})
