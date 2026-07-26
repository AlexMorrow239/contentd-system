import { describe, expect, it } from 'vitest'
import { dueSlotsForChannel, localDay, localHHMM, orderCandidates } from './slots.js'
import type { SlotCandidate } from './slots.js'

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
