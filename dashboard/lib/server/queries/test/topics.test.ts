import type { Database } from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { listTopics } from '../../../../../daemon/src/features/topics/queries.js'
import { memDb, seedTopic as seedTopicRow } from '../../../../../daemon/testing/db.js'
import { countTopics, getTopic, topicActions, topicChannels } from '../topics.js'

it('loads topic details and matches bulk and single-topic actions, preferring active work', () => {
  const db = memDb()
  const first = seedTopicRow(db, { title: 'First' })
  const second = seedTopicRow(db, { title: 'Second' })
  const insert = db.prepare(
    'INSERT INTO operator_actions (kind, lane, args, status, requested_by) VALUES (?, ?, ?, ?, ?)',
  )
  const active = Number(
    insert.run('topics.reject', 'fast', JSON.stringify({ ids: [first, second] }), 'pending', 'test')
      .lastInsertRowid,
  )
  insert.run('topics.requeue', 'fast', JSON.stringify({ id: first }), 'done', 'test')
  insert.run('topics.reject', 'fast', 'invalid json', 'pending', 'test')
  expect(getTopic(db, first)?.title).toBe('First')
  expect(getTopic(db, 999999)).toBeNull()
  expect(topicActions(db, [first, second]).get(first)?.id).toBe(active)
  expect(topicActions(db, [first, second]).get(second)?.id).toBe(active)
  db.prepare('UPDATE operator_actions SET status = ? WHERE id = ?').run('done', active)
  expect(topicActions(db, [first]).get(first)?.kind).toBe('topics.requeue')
  expect(topicActions(db, []).size).toBe(0)
})

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
  it('shares literal case-insensitive search with the ranked, paginated topic list', () => {
    const db = memDb()
    const first = seedTopicRow(db, { title: 'Space 100%_match', score: 90 })
    const second = seedTopicRow(db, { title: 'SPACE 100%_MATCH again', score: 80 })
    seedTopicRow(db, { title: 'Space 100XXmatch', score: 99 })
    seedTopicRow(db, { title: 'Space 100%_match', channel: 'other' })
    seedTopicRow(db, {
      title: 'Space 100%_match',
      status: 'rejected',
      dedupeHash: 'rejected-match',
    })
    const filter = { channel: 'chan-a', status: 'candidate' as const, q: '100%_MaTcH' }
    expect(countTopics(db, filter)).toBe(2)
    expect(listTopics(db, { ...filter, order: 'score', limit: 1 }).map((row) => row.id)).toEqual([
      first,
    ])
    expect(
      listTopics(db, { ...filter, order: 'score', limit: 1, offset: 1 }).map((row) => row.id),
    ).toEqual([second])
    expect(listTopics(db, { q: String(second) }).map((row) => row.id)).toContain(second)
  })

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
