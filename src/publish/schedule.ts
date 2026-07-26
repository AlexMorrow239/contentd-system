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

// The local-hour window uploads are allowed in. Deliberately NOT
// configurable: the operator sets volume (videos_per_day) and the schedule is
// derived from it. End is exclusive, so 21:00 itself is outside.
export const PUBLISH_WINDOW_START_HOUR = 9
export const PUBLISH_WINDOW_END_HOUR = 21

const HOUR_MS = 3_600_000

export function isInPublishWindow(now: Date): boolean {
  const hour = now.getHours()
  return hour >= PUBLISH_WINDOW_START_HOUR && hour < PUBLISH_WINDOW_END_HOUR
}

/**
 * Minimum spacing between two publish attempts for ONE channel: the window
 * divided by the day's video count — 3/day over a 12h window is one every 4h.
 * Floored, never rounded up, so N gaps always fit inside the window.
 * videosPerDay is a positive integer (config schema guarantees it), so the
 * result is always >= 1ms.
 */
export function minGapMs(videosPerDay: number): number {
  const windowMs = (PUBLISH_WINDOW_END_HOUR - PUBLISH_WINDOW_START_HOUR) * HOUR_MS
  return Math.floor(windowMs / videosPerDay)
}

export type NotDueReason = 'not-in-window' | 'paced' | 'daily-count-met'

/**
 * Why a channel is not due, or undefined when it IS due. Returns the reason
 * rather than a boolean so the tick can report WHICH gate closed instead of a
 * single opaque no-op.
 *
 * Gate order is the order of specificity, not of cost: an out-of-window tick
 * says so even if the count is also met, and a met count outranks pacing
 * because it is the more informative of the two.
 *
 * `lastAttemptAt` is deliberately not day-scoped by the caller — the gap must
 * measure correctly across midnight, where a day-scoped read would see null
 * and publish immediately at 00:00.
 */
export function channelNotDueReason(opts: {
  videosPerDay: number
  publishedToday: number
  lastAttemptAt: Date | null
  now: Date
}): NotDueReason | undefined {
  if (!isInPublishWindow(opts.now)) return 'not-in-window'
  if (opts.publishedToday >= opts.videosPerDay) return 'daily-count-met'
  if (
    opts.lastAttemptAt !== null &&
    opts.now.getTime() - opts.lastAttemptAt.getTime() < minGapMs(opts.videosPerDay)
  ) {
    return 'paced'
  }
  return undefined
}

export interface ChannelCandidate {
  channel: string
  publishedToday: number
  videosPerDay: number
}

/**
 * Fairness order for the tick's candidate pass: least-filled channel first,
 * channel name last for determinism across ticks with identical fractions.
 * The fraction is compared by cross-multiplication rather than division —
 * both denominators are positive integers, so this preserves the comparison's
 * direction with zero float-rounding risk. Pure: sorts a copy.
 */
export function orderChannels(candidates: ChannelCandidate[]): ChannelCandidate[] {
  return [...candidates].sort((a, b) => {
    const diff = a.publishedToday * b.videosPerDay - b.publishedToday * a.videosPerDay
    if (diff !== 0) return diff
    return a.channel < b.channel ? -1 : a.channel > b.channel ? 1 : 0
  })
}
