import { describe, expect, it } from 'vitest'
import { digestUnit, DIGEST_HOUR } from '../digest-unit.js'
import { memDb } from '../../testing/db.js'
import { channelToml, writeChannelsDir } from '../../testing/channel.js'

/** A mutable clock the time-gated units take as `now`, so no test ever waits. */
function fakeClock(start: Date): { now: () => Date; advance: (ms: number) => void } {
  let ms = start.getTime()
  return {
    now: () => new Date(ms),
    advance: (delta: number) => {
      ms += delta
    },
  }
}

describe('digestUnit', () => {
  it('does nothing before DIGEST_HOUR', async () => {
    const db = memDb()
    const channelsDir = writeChannelsDir({ 'a.toml': channelToml({ name: 'a' }) })
    const clock = fakeClock(new Date(2026, 6, 28, DIGEST_HOUR - 1, 59))
    const unit = digestUnit(db, { channelsDir, now: clock.now })
    expect(await unit()).toEqual({ worked: false })
  })

  it('fires once after DIGEST_HOUR and not again the same day', async () => {
    const db = memDb()
    const channelsDir = writeChannelsDir({ 'a.toml': channelToml({ name: 'a' }) })
    const clock = fakeClock(new Date(2026, 6, 28, DIGEST_HOUR, 1))
    const unit = digestUnit(db, { channelsDir, now: clock.now })

    const first = await unit()
    expect(first.worked).toBe(true)
    expect(first.line?.action).toBe('digest')
    expect(typeof first.line?.text).toBe('string')

    clock.advance(3_600_000)
    expect(await unit()).toEqual({ worked: false })
  })

  it('fires again on the next local day', async () => {
    const db = memDb()
    const channelsDir = writeChannelsDir({ 'a.toml': channelToml({ name: 'a' }) })
    const clock = fakeClock(new Date(2026, 6, 28, DIGEST_HOUR, 1))
    const unit = digestUnit(db, { channelsDir, now: clock.now })

    expect((await unit()).worked).toBe(true)
    clock.advance(86_400_000)
    expect((await unit()).worked).toBe(true)
  })
})
