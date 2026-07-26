import type { Platform } from './types.js'

// 'YYYY-MM-DD' in the MACHINE's local time zone — never toISOString() (that
// renders UTC). Slot bookkeeping is deliberately local (design spec §13): a
// channel's posting slots are wall-clock times on this machine, not UTC.
export function localDay(now: Date): string {
  const year = now.getFullYear()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

// 'HH:MM' zero-padded machine-local. Same-length zero-padded strings compare
// lexicographically in chronological order, which is what dueSlotsForChannel
// and the channel config's `slots` entries rely on.
export function localHHMM(now: Date): string {
  const hours = String(now.getHours()).padStart(2, '0')
  const minutes = String(now.getMinutes()).padStart(2, '0')
  return `${hours}:${minutes}`
}

// Slots whose time has arrived — slot <= now, so a slot exactly matching the
// current minute counts as due (design spec §6 step 3) — and that have not
// already consumed a publishes row today. `slots` is a target's resolved
// per-platform list, already sorted ascending by the config loader.
export function dueSlotsForChannel(slots: string[], consumed: Set<string>, now: Date): string[] {
  const nowHHMM = localHHMM(now)
  return slots.filter((slot) => slot <= nowHHMM && !consumed.has(slot))
}

export interface SlotCandidate {
  channel: string
  platform: Platform
  slot: string
  filledCount: number
  totalSlots: number
}

// Fairness order for the tick's candidate pass (design spec §6 step 5):
// least-filled channel first, earliest due slot next, channel name last for
// determinism across ticks with identical fractions. filledCount/totalSlots
// is compared by cross-multiplication (a.filledCount * b.totalSlots vs
// b.filledCount * a.totalSlots) instead of division — totalSlots is always a
// positive slot count, so multiplying preserves the comparison's direction
// with zero float-rounding risk. Pure: sorts a copy, never the caller's array.
export function orderCandidates(candidates: SlotCandidate[]): SlotCandidate[] {
  return [...candidates].sort((a, b) => {
    const fractionDiff = a.filledCount * b.totalSlots - b.filledCount * a.totalSlots
    if (fractionDiff !== 0) return fractionDiff
    if (a.slot !== b.slot) return a.slot < b.slot ? -1 : 1
    return a.channel < b.channel ? -1 : a.channel > b.channel ? 1 : 0
  })
}
