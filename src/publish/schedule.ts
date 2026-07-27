// 'YYYY-MM-DD' in the MACHINE's local time zone — never toISOString() (that
// renders UTC). The publish day is deliberately local (design spec §13): a
// channel's posting window is wall-clock time on this machine, not UTC.
export function localDay(now: Date): string {
  const year = now.getFullYear()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
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
