import { describe, expect, it } from 'vitest'
import { memDb } from '../testing/db.js'
import { buildDigest } from './digest.js'

/**
 * The assembled document: section order.
 *
 * Split from a single 964-line digest.test.ts whose fifteen describes already
 * mapped 1:1 onto sections of the digest's output. Shared seeds live in
 * _digest.fixtures.ts.
 */

describe('buildDigest — section order', () => {
  it('emits the five sections in the pinned order', () => {
    const db = memDb()
    const digest = buildDigest(db, [])
    const positions = [
      digest.indexOf('Topics (last 24h)'),
      digest.indexOf('Jobs (last 24h)'),
      digest.indexOf('Spend today (UTC)'),
      digest.indexOf('Publishing (last 24h)'),
      digest.indexOf('Action items'),
    ]
    expect(positions.every((p) => p >= 0)).toBe(true)
    expect([...positions].sort((a, b) => a - b)).toEqual(positions)
    db.close()
  })
})
