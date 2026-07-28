import { describe, expect, it } from 'vitest'
import { channelNotDueReason, localDay, orderChannels, PUBLISH_COOLDOWN_MS } from '../schedule.js'

// Offset-less ISO strings (no trailing 'Z' or '+HH:MM') parse as LOCAL time,
// not UTC — the 03:17-local and midnight-crossing tests below depend on this.
const at = (iso: string): Date => new Date(iso)

describe('localDay', () => {
  it('renders YYYY-MM-DD in local time, zero-padded', () => {
    expect(localDay(new Date(2026, 6, 22, 14, 30))).toBe('2026-07-22')
  })

  it('zero-pads a single-digit month and day', () => {
    expect(localDay(new Date(2026, 0, 5, 9, 3))).toBe('2026-01-05')
  })
})

describe('channelNotDueReason', () => {
  it('is due at any hour of the day once past the cooldown', () => {
    // 03:17 local — outside the old 09:00-21:00 posting window
    expect(
      channelNotDueReason({
        videosPerDay: 3,
        publishedToday: 0,
        lastAttemptAt: null,
        now: at('2026-07-28T03:17:00'),
      }),
    ).toBeUndefined()
  })

  it('returns daily-count-met at the quota regardless of cooldown', () => {
    const now = at('2026-07-28T10:00:00')
    expect(
      channelNotDueReason({
        videosPerDay: 3,
        publishedToday: 3,
        lastAttemptAt: new Date(now.getTime() - 1),
        now,
      }),
    ).toBe('daily-count-met')
  })

  it('returns daily-count-met when publishedToday exceeds the quota', () => {
    expect(
      channelNotDueReason({
        videosPerDay: 3,
        publishedToday: 4,
        lastAttemptAt: null,
        now: at('2026-07-28T10:00:00'),
      }),
    ).toBe('daily-count-met')
  })

  it('returns paced inside the cooldown', () => {
    const now = at('2026-07-28T10:00:00')
    const last = new Date(now.getTime() - PUBLISH_COOLDOWN_MS + 1)
    expect(
      channelNotDueReason({ videosPerDay: 3, publishedToday: 1, lastAttemptAt: last, now }),
    ).toBe('paced')
  })

  it('is due exactly at the cooldown boundary', () => {
    const now = at('2026-07-28T10:00:00')
    const last = new Date(now.getTime() - PUBLISH_COOLDOWN_MS)
    expect(
      channelNotDueReason({ videosPerDay: 3, publishedToday: 1, lastAttemptAt: last, now }),
    ).toBeUndefined()
  })

  it('measures the cooldown across midnight', () => {
    // 23:55 attempt, 00:02 check: 7 min elapsed < 10 min cooldown
    expect(
      channelNotDueReason({
        videosPerDay: 3,
        publishedToday: 0, // new local day, count reset
        lastAttemptAt: at('2026-07-27T23:55:00'),
        now: at('2026-07-28T00:02:00'),
      }),
    ).toBe('paced')
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
