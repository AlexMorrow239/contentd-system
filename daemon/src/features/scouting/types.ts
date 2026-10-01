export interface ScoutChannelResult {
  channel: string
  fetched: number
  droppedMedia: number
  droppedAutomated: number
  /**
   * Story channels only: candidates with no narratable body (a link post, or
   * an r/AskReddit-style title-only post whose story lives in comments the
   * source does not fetch). Always 0 on a topic-mode channel.
   */
  droppedBodyless: number
  alreadyKnown: number
  scored: number
  queued: number
  rejected: number
  sourceErrors: string[]
  costUsdMicros: number
  scoringError?: string
  /**
   * Set when the channel was not scouted at all. 'queue-full' means it already
   * holds queue_days' worth of candidates — a healthy outcome, not a failure.
   * 'recheck-not-due' means an attempt landed within SCOUT_RECHECK_MS of now.
   * Both are distinguishable from the all-zero result a channel with no fresh
   * candidates produces.
   */
  skipped?: 'queue-full' | 'recheck-not-due'
}
