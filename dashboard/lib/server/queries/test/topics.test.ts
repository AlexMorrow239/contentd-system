import { describe, expect, it } from 'vitest'
import type { Database } from 'better-sqlite3'
import { countTopics, topicChannels } from '../topics.js'
import { memDb, seedTopic as seedTopicRow } from '../../../../../src/testing/db.js'

let seq = 0
function seedTopic(
  db: Database,
  overrides: Partial<{ channel: string; status: string }> = {},
): void {
  seq += 1
  seedTopicRow(db, {
    channel: overrides.channel ?? 'space',
    title: `Topic ${seq}`,
    rawTitle: `Raw ${seq}`,
    source: 'reddit:r/space',
    url: `https://example.com/${seq}`,
    dedupeHash: `hash-${seq}`,
    score: 50,
    reason: 'ok',
    status: overrides.status ?? 'candidate',
  })
}

describe('topicChannels', () => {
  it('lists distinct channels alphabetically, straight from the topics table', () => {
    const db = memDb()
    seedTopic(db, { channel: 'space' })
    seedTopic(db, { channel: 'ocean' })
    seedTopic(db, { channel: 'space' })
    expect(topicChannels(db)).toEqual(['ocean', 'space'])
    db.close()
  })

  it('is unaffected by any status/channel filter — always the full dropdown', () => {
    const db = memDb()
    seedTopic(db, { channel: 'space', status: 'rejected' })
    seedTopic(db, { channel: 'ocean', status: 'candidate' })
    expect(topicChannels(db)).toEqual(['ocean', 'space'])
    db.close()
  })
})

describe('countTopics', () => {
  it('counts all matching rows regardless of any limit applied elsewhere', () => {
    const db = memDb()
    seedTopic(db)
    seedTopic(db)
    expect(countTopics(db)).toBe(2)
    db.close()
  })

  it('applies the same channel and status filters as listTopics', () => {
    const db = memDb()
    seedTopic(db, { channel: 'space', status: 'candidate' })
    seedTopic(db, { channel: 'space', status: 'rejected' })
    seedTopic(db, { channel: 'ocean', status: 'candidate' })
    expect(countTopics(db, { channel: 'space' })).toBe(2)
    expect(countTopics(db, { status: 'candidate' })).toBe(2)
    expect(countTopics(db, { channel: 'space', status: 'candidate' })).toBe(1)
    db.close()
  })
})
