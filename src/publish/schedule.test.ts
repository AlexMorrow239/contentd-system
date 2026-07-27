import { describe, expect, it } from 'vitest'
import {
  channelNotDueReason,
  isInPublishWindow,
  localDay,
  minGapMs,
  orderChannels,
} from './schedule.js'

describe('localDay', () => {
  it('renders YYYY-MM-DD in local time, zero-padded', () => {
    expect(localDay(new Date(2026, 6, 22, 14, 30))).toBe('2026-07-22')
  })

  it('zero-pads a single-digit month and day', () => {
    expect(localDay(new Date(2026, 0, 5, 9, 3))).toBe('2026-01-05')
  })
})

describe('isInPublishWindow', () => {
  it('is false one minute before the window opens', () => {
    expect(isInPublishWindow(new Date(2026, 6, 22, 8, 59))).toBe(false)
  })

  it('is true exactly at the opening hour', () => {
    expect(isInPublishWindow(new Date(2026, 6, 22, 9, 0))).toBe(true)
  })

  it('is true one minute before the closing hour', () => {
    expect(isInPublishWindow(new Date(2026, 6, 22, 20, 59))).toBe(true)
  })

  it('is false exactly at the closing hour (end is exclusive)', () => {
    expect(isInPublishWindow(new Date(2026, 6, 22, 21, 0))).toBe(false)
  })

  it('is false in the small hours', () => {
    expect(isInPublishWindow(new Date(2026, 6, 22, 3, 15))).toBe(false)
  })
})

describe('minGapMs', () => {
  it('is the whole 12h window at one video per day', () => {
    expect(minGapMs(1)).toBe(12 * 3_600_000)
  })

  it('is 4h at three videos per day', () => {
    expect(minGapMs(3)).toBe(4 * 3_600_000)
  })

  it('is 2h at six videos per day', () => {
    expect(minGapMs(6)).toBe(2 * 3_600_000)
  })

  it('floors rather than rounding up, so the gap never exceeds a fair share', () => {
    // 12h / 5 = 2.4h = 8_640_000ms exactly; 12h / 7 does not divide evenly.
    expect(minGapMs(7)).toBe(Math.floor((12 * 3_600_000) / 7))
    expect(minGapMs(7) * 7).toBeLessThanOrEqual(12 * 3_600_000)
  })
})

describe('channelNotDueReason', () => {
  const base = { videosPerDay: 3, publishedToday: 0, lastAttemptAt: null }

  it('is undefined (due) inside the window with nothing published yet', () => {
    expect(channelNotDueReason({ ...base, now: new Date(2026, 6, 22, 9, 0) })).toBeUndefined()
  })

  it('reports not-in-window outside the window, even with quota and gap free', () => {
    expect(channelNotDueReason({ ...base, now: new Date(2026, 6, 22, 2, 0) })).toBe('not-in-window')
  })

  it('reports daily-count-met once the day count is reached', () => {
    expect(
      channelNotDueReason({
        ...base,
        publishedToday: 3,
        now: new Date(2026, 6, 22, 19, 0),
      }),
    ).toBe('daily-count-met')
  })

  it('reports daily-count-met over the count too, not just at it', () => {
    expect(
      channelNotDueReason({
        ...base,
        publishedToday: 4,
        now: new Date(2026, 6, 22, 19, 0),
      }),
    ).toBe('daily-count-met')
  })

  it('reports paced when the last attempt is inside the min gap', () => {
    expect(
      channelNotDueReason({
        ...base,
        publishedToday: 1,
        lastAttemptAt: new Date(2026, 6, 22, 10, 0),
        now: new Date(2026, 6, 22, 13, 59),
      }),
    ).toBe('paced')
  })

  it('is due exactly at the min gap boundary (gap == elapsed counts as due)', () => {
    expect(
      channelNotDueReason({
        ...base,
        publishedToday: 1,
        lastAttemptAt: new Date(2026, 6, 22, 10, 0),
        now: new Date(2026, 6, 22, 14, 0),
      }),
    ).toBeUndefined()
  })

  it('measures the gap across midnight, not within the day', () => {
    // 20:50 yesterday to 09:00 today is 12h10m — past a 4h gap.
    expect(
      channelNotDueReason({
        ...base,
        lastAttemptAt: new Date(2026, 6, 21, 20, 50),
        now: new Date(2026, 6, 22, 9, 0),
      }),
    ).toBeUndefined()
  })

  it('prefers daily-count-met over paced when both gates are closed', () => {
    expect(
      channelNotDueReason({
        ...base,
        publishedToday: 3,
        lastAttemptAt: new Date(2026, 6, 22, 12, 55),
        now: new Date(2026, 6, 22, 13, 0),
      }),
    ).toBe('daily-count-met')
  })
})

describe('orderChannels', () => {
  it('sorts by filled fraction ascending, not by absolute count', () => {
    // 1/3 vs 0/2: the 0-filled channel is emptier despite a smaller day.
    const ordered = orderChannels([
      { channel: 'chan-a', publishedToday: 1, videosPerDay: 3 },
      { channel: 'chan-b', publishedToday: 0, videosPerDay: 2 },
    ])
    expect(ordered.map((c) => c.channel)).toEqual(['chan-b', 'chan-a'])
  })

  it('breaks an equal fraction by channel name for determinism', () => {
    const ordered = orderChannels([
      { channel: 'zeta', publishedToday: 1, videosPerDay: 2 },
      { channel: 'alpha', publishedToday: 2, videosPerDay: 4 },
    ])
    expect(ordered.map((c) => c.channel)).toEqual(['alpha', 'zeta'])
  })

  it('never mutates the caller array', () => {
    const input = [
      { channel: 'chan-b', publishedToday: 0, videosPerDay: 2 },
      { channel: 'chan-a', publishedToday: 0, videosPerDay: 2 },
    ]
    orderChannels(input)
    expect(input.map((c) => c.channel)).toEqual(['chan-b', 'chan-a'])
  })
})
