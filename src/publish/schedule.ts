// 'YYYY-MM-DD' in the MACHINE's local time zone — never toISOString() (that
// renders UTC). The publish day is deliberately local (design spec §13): a
// channel's posting window is wall-clock time on this machine, not UTC.
export function localDay(now: Date): string {
  const year = now.getFullYear()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

// The floor between two publish attempts for ONE channel. Deliberately a
// constant, not config: this is an anti-burst guard (a platform seeing six
// uploads land in three minutes reads it as spam), not a schedule. Demand —
// videos_per_day still unmet today — is the only thing that makes a channel
// due; this only stops the demand from discharging as a single burst.
export const PUBLISH_COOLDOWN_MS = 600_000 // 10 min

export type NotDueReason = 'paced' | 'daily-count-met'

/**
 * Why a channel is not due, or undefined when it IS due. There is no posting
 * window anymore: the day quota (videos_per_day, per local calendar day) and
 * the cooldown are the only gates.
 *
 * `lastAttemptAt` is deliberately not day-scoped by the caller — the cooldown
 * must measure correctly across midnight, where a day-scoped read would see
 * null and fire at 00:00 sharp.
 */
export function channelNotDueReason(opts: {
  videosPerDay: number
  publishedToday: number
  lastAttemptAt: Date | null
  now: Date
}): NotDueReason | undefined {
  if (opts.publishedToday >= opts.videosPerDay) return 'daily-count-met'
  if (
    opts.lastAttemptAt !== null &&
    opts.now.getTime() - opts.lastAttemptAt.getTime() < PUBLISH_COOLDOWN_MS
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
