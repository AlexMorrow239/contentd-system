import { describe, expect, it } from 'vitest'
import { scoutUnit } from '../scout-unit.js'
import { acquireLease, releaseLease } from '../lease.js'
import { ScoutRunFailedError } from '../../scout/scout.js'
import type { ScoutChannelResult } from '../../scout/scout.js'
import { memDb } from '../../../testing/db.js'
import { channelToml, writeChannelsDir } from '../../../testing/channel.js'

function scoutResult(channel: string, over: Partial<ScoutChannelResult> = {}): ScoutChannelResult {
  return {
    channel,
    fetched: 0,
    droppedMedia: 0,
    droppedAutomated: 0,
    droppedBodyless: 0,
    alreadyKnown: 0,
    scored: 0,
    queued: 0,
    rejected: 0,
    sourceErrors: [],
    costUsdMicros: 0,
    ...over,
  }
}

/**
 * One channel on disk plus a counting stub in place of scoutAll — the channel
 * declares no `[scout]` table since the stub decides what scouting "returns",
 * so the real source list never matters.
 */
function scoutFixture(scout: () => Promise<ScoutChannelResult[]>): {
  db: ReturnType<typeof memDb>
  channelsDir: string
  calls: () => number
  scout: () => Promise<ScoutChannelResult[]>
} {
  let calls = 0
  return {
    db: memDb(),
    channelsDir: writeChannelsDir({ 'a.toml': channelToml({ name: 'a' }) }),
    calls: () => calls,
    scout: async () => {
      calls++
      return scout()
    },
  }
}

// Midday, so the scout recheck arithmetic never straddles a day boundary.
const SCOUT_NOW = new Date(2026, 6, 28, 12, 0, 0)

describe('scoutUnit', () => {
  // The recheck cadence and the queue-depth gate both live inside
  // scoutChannel/scoutAll now (backed by the persisted scout_state table),
  // so scoutUnit itself carries no scheduling state — it calls `scout` on
  // every loaded channel on every invocation and just maps the outcome.
  // Recheck/queue-depth behavior itself is covered in scout.test.ts.

  it('scouts on every call — no per-channel scheduling of its own', async () => {
    const fx = scoutFixture(async () => [scoutResult('a', { queued: 1 })])
    const unit = scoutUnit(fx.db, {
      channelsDir: fx.channelsDir,
      now: () => SCOUT_NOW,
      scout: fx.scout,
    })

    expect((await unit()).worked).toBe(true)
    expect((await unit()).worked).toBe(true)
    expect(fx.calls()).toBe(2)
  })

  it('is idle without a line when every channel is skipped as not-yet-due', async () => {
    const fx = scoutFixture(async () => [scoutResult('a', { skipped: 'recheck-not-due' })])
    const unit = scoutUnit(fx.db, {
      channelsDir: fx.channelsDir,
      now: () => SCOUT_NOW,
      scout: fx.scout,
    })

    expect(await unit()).toEqual({ worked: false })
  })

  it('reports queue-full when every skipped result includes at least one queue-full', async () => {
    const fx = scoutFixture(async () => [
      scoutResult('a', { skipped: 'queue-full' }),
      scoutResult('b', { skipped: 'recheck-not-due' }),
    ])
    const unit = scoutUnit(fx.db, {
      channelsDir: fx.channelsDir,
      now: () => SCOUT_NOW,
      scout: fx.scout,
    })

    expect(await unit()).toEqual({ worked: false, line: { action: 'noop', reason: 'queue-full' } })
  })

  it('names an empty scout pass no-scout-sources, not queue-full', async () => {
    // Real scoutAll here, not the stub: the fixture channel declares no
    // `[scout]` table, so scoutAll skips it without touching a source and
    // returns []. `[].every(...)` is vacuously true, which used to report
    // this as `queue-full` — a queue depth nothing ever measured.
    const db = memDb()
    const channelsDir = writeChannelsDir({ 'a.toml': channelToml({ name: 'a' }) })
    const unit = scoutUnit(db, { channelsDir, now: () => SCOUT_NOW })

    expect(await unit()).toEqual({
      worked: false,
      line: { action: 'noop', reason: 'no-scout-sources' },
    })
  })

  it('reports lease-held as idle without calling scout', async () => {
    const fx = scoutFixture(async () => [scoutResult('a', { queued: 1 })])
    const unit = scoutUnit(fx.db, {
      channelsDir: fx.channelsDir,
      now: () => SCOUT_NOW,
      scout: fx.scout,
    })
    expect(acquireLease(fx.db, 'scout', 'someone-else', 600_000)).toBe(true)

    expect(await unit()).toEqual({ worked: false, line: { action: 'noop', reason: 'lease-held' } })
    expect(fx.calls()).toBe(0)

    releaseLease(fx.db, 'scout', 'someone-else')
    expect((await unit()).worked).toBe(true)
    expect(fx.calls()).toBe(1)
  })

  it('a ScoutRunFailedError still counts as worked', async () => {
    const fx = scoutFixture(async () => {
      throw new ScoutRunFailedError('every source failed', [])
    })
    const unit = scoutUnit(fx.db, {
      channelsDir: fx.channelsDir,
      now: () => SCOUT_NOW,
      scout: fx.scout,
    })

    const result = await unit()
    expect(result.worked).toBe(true)
    expect(result.line).toMatchObject({ action: 'scouted', channels: [] })
    expect(String(result.line?.error)).toContain('every source failed')
  })

  it('reports a broken channels dir as a config-error noop', async () => {
    const db = memDb()
    const channelsDir = writeChannelsDir({ 'a.toml': 'not = [valid' })
    const unit = scoutUnit(db, {
      channelsDir,
      now: () => SCOUT_NOW,
      scout: async () => {
        throw new Error('must not be called')
      },
    })
    const result = await unit()
    expect(result.worked).toBe(false)
    expect(result.line).toMatchObject({ action: 'noop', reason: 'config-error' })
  })

  it('releases the scout lease after a run', async () => {
    const fx = scoutFixture(async () => [scoutResult('a', { queued: 1 })])
    const unit = scoutUnit(fx.db, {
      channelsDir: fx.channelsDir,
      now: () => SCOUT_NOW,
      scout: fx.scout,
    })
    await unit()
    expect(acquireLease(fx.db, 'scout', 'someone-else', 1000)).toBe(true)
  })
})
