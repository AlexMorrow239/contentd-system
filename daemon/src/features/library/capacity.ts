import type { ChannelConfig } from '../../config/channel.js'

// The inventory ceiling: how many finished, unposted videos a channel may
// hold before it stops producing. Derived from videos_per_day so that knob
// stays the single cadence dial — it now means "how many I intend to post per
// day".
//
// Exported for the digest, which reports channels sitting at this cap: a
// halted channel is otherwise invisible, and two definitions of the ceiling
// would let the report and the gate disagree about who is halted.
export function backlogCap(channel: ChannelConfig): number {
  return Math.ceil(channel.videosPerDay * channel.backlogDays)
}
