import { createTestTime } from '../../../testing/time.js'
import { describe, expect, it } from 'vitest'
import { digestUnit, DIGEST_HOUR } from '../digest-unit.js'
import { memDb } from '../../../testing/db.js'
import { channelToml, writeChannelsDir } from '../../../testing/channel.js'

describe('digestUnit', () => {
  it('does nothing before DIGEST_HOUR', async () => {
    const db = memDb()
    const channelsDir = writeChannelsDir({ 'a.toml': channelToml({ name: 'a' }) })
    const clock = createTestTime(new Date(2026, 6, 28, DIGEST_HOUR - 1, 59))
    const unit = digestUnit(db, { channelsDir, time: clock })
    expect(await unit()).toEqual({ worked: false })
  })

  it('fires once after DIGEST_HOUR and not again the same day', async () => {
    const db = memDb()
    const channelsDir = writeChannelsDir({ 'a.toml': channelToml({ name: 'a' }) })
    const clock = createTestTime(new Date(2026, 6, 28, DIGEST_HOUR, 1))
    const unit = digestUnit(db, { channelsDir, time: clock })

    const first = await unit()
    expect(first.worked).toBe(true)
    expect(first.line?.action).toBe('digest')
    expect(typeof first.line?.text).toBe('string')

    await clock.advanceBy(3_600_000)
    expect(await unit()).toEqual({ worked: false })
  })

  it('fires again on the next local day', async () => {
    const db = memDb()
    const channelsDir = writeChannelsDir({ 'a.toml': channelToml({ name: 'a' }) })
    const clock = createTestTime(new Date(2026, 6, 28, DIGEST_HOUR, 1))
    const unit = digestUnit(db, { channelsDir, time: clock })

    expect((await unit()).worked).toBe(true)
    await clock.advanceBy(86_400_000)
    expect((await unit()).worked).toBe(true)
  })
})
