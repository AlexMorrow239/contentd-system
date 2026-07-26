import { describe, expect, it } from 'vitest'
import {
  channelNotDueReason,
  dueSlotsForChannel,
  isInPublishWindow,
  localDay,
  localHHMM,
  minGapMs,
  orderCandidates,
  orderChannels,
} from './schedule.js'
import type { SlotCandidate } from './schedule.js'

describe('localDay', () => {
  it('renders YYYY-MM-DD in local time, zero-padded', () => {
    expect(localDay(new Date(2026, 6, 22, 14, 30))).toBe('2026-07-22')
  })

  it('zero-pads a single-digit month and day', () => {
    expect(localDay(new Date(2026, 0, 5, 9, 3))).toBe('2026-01-05')
  })
})

describe('localHHMM', () => {
  it('renders HH:MM in local time, zero-padded', () => {
    expect(localHHMM(new Date(2026, 6, 22, 14, 30))).toBe('14:30')
  })

  it('zero-pads a single-digit hour and minute', () => {
    expect(localHHMM(new Date(2026, 0, 5, 9, 3))).toBe('09:03')
  })
})

describe('dueSlotsForChannel', () => {
  const slots = ['10:00', '14:00', '19:00']

  it('is empty before the first slot', () => {
    expect(dueSlotsForChannel(slots, new Set(), new Date(2026, 6, 22, 9, 59))).toEqual([])
  })

  it('includes a slot exactly at its boundary (slot == now counts as due)', () => {
    expect(dueSlotsForChannel(slots, new Set(), new Date(2026, 6, 22, 10, 0))).toEqual(['10:00'])
  })

  it('includes only slots at-or-before now, preserving ascending order', () => {
    expect(dueSlotsForChannel(slots, new Set(), new Date(2026, 6, 22, 14, 30))).toEqual([
      '10:00',
      '14:00',
    ])
  })

  it('includes every slot once the day is done, with an empty consumed set', () => {
    expect(dueSlotsForChannel(slots, new Set(), new Date(2026, 6, 22, 23, 0))).toEqual([
      '10:00',
      '14:00',
      '19:00',
    ])
  })

  it('is empty once every slot for the day is consumed', () => {
    const consumed = new Set(['10:00', '14:00', '19:00'])
    expect(dueSlotsForChannel(slots, consumed, new Date(2026, 6, 22, 23, 0))).toEqual([])
  })

  it('skips only the consumed slots, preserving order for the rest', () => {
    const consumed = new Set(['14:00'])
    expect(dueSlotsForChannel(slots, consumed, new Date(2026, 6, 22, 23, 0))).toEqual([
      '10:00',
      '19:00',
    ])
  })
})

function candidate(overrides: Partial<SlotCandidate> = {}): SlotCandidate {
  return {
    channel: 'chan-a',
    platform: 'youtube',
    slot: '10:00',
    filledCount: 0,
    totalSlots: 1,
    ...overrides,
  }
}

describe('orderCandidates', () => {
  it('sorts by filled fraction ascending via integer cross-multiplication (0-filled beats a partial channel)', () => {
    // 1/3 (chan-a) vs 0/2 (chan-b): 0/2 is the emptier channel despite fewer total slots.
    const a = candidate({ channel: 'chan-a', filledCount: 1, totalSlots: 3 })
    const b = candidate({ channel: 'chan-b', filledCount: 0, totalSlots: 2 })
    expect(orderCandidates([a, b]).map((c) => c.channel)).toEqual(['chan-b', 'chan-a'])
  })

  it('breaks a fraction tie (1/2 == 2/4) by slot ascending', () => {
    const late = candidate({ channel: 'chan-c', slot: '11:00', filledCount: 1, totalSlots: 2 })
    const early = candidate({ channel: 'chan-d', slot: '09:00', filledCount: 2, totalSlots: 4 })
    expect(orderCandidates([late, early]).map((c) => c.channel)).toEqual(['chan-d', 'chan-c'])
  })

  it('breaks a fraction+slot tie by channel name ascending', () => {
    const z = candidate({ channel: 'chan-z', slot: '10:00', filledCount: 1, totalSlots: 2 })
    const a = candidate({ channel: 'chan-a', slot: '10:00', filledCount: 1, totalSlots: 2 })
    expect(orderCandidates([z, a]).map((c) => c.channel)).toEqual(['chan-a', 'chan-z'])
  })

  it('returns a new array, leaving the input order untouched', () => {
    const a = candidate({ channel: 'chan-a', filledCount: 1, totalSlots: 3 })
    const b = candidate({ channel: 'chan-b', filledCount: 0, totalSlots: 2 })
    const input = [a, b]
    const output = orderCandidates(input)
    expect(output).not.toBe(input)
    expect(input.map((c) => c.channel)).toEqual(['chan-a', 'chan-b'])
    expect(output.map((c) => c.channel)).toEqual(['chan-b', 'chan-a'])
  })

  it('applies all three tiebreakers together across a mixed candidate set', () => {
    const candidates = [
      candidate({ channel: 'chan-z', slot: '10:00', filledCount: 1, totalSlots: 2 }), // 0.5
      candidate({ channel: 'chan-a', slot: '10:00', filledCount: 1, totalSlots: 2 }), // 0.5, ties chan-z
      candidate({ channel: 'chan-b', slot: '09:00', filledCount: 0, totalSlots: 3 }), // 0
      candidate({ channel: 'chan-c', slot: '11:00', filledCount: 0, totalSlots: 5 }), // 0, ties chan-b on fraction, later slot
    ]
    expect(orderCandidates(candidates).map((c) => c.channel)).toEqual([
      'chan-b',
      'chan-c',
      'chan-a',
      'chan-z',
    ])
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
    expect(
      channelNotDueReason({ ...base, now: new Date(2026, 6, 22, 9, 0) }),
    ).toBeUndefined()
  })

  it('reports not-in-window outside the window, even with quota and gap free', () => {
    expect(channelNotDueReason({ ...base, now: new Date(2026, 6, 22, 2, 0) })).toBe(
      'not-in-window',
    )
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
