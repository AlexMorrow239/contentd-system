import type { Database } from 'better-sqlite3'
import type { Logger } from 'pino'
import type { ChannelConfig } from '../config/channel.js'
import type { StoryPart } from '../stories/types.js'

// One list, type derived (the pattern posts/types.ts sets for PLATFORMS):
// reordering or renaming a stage here cannot leave a stale union behind.
// Unrelated to DASHBOARD_STAGE_ORDER, which is a deliberate second copy the
// dashboard keeps so a viewer never loads the pipeline module.
export const STAGE_ORDER = ['script', 'voice', 'captions', 'visuals', 'assemble', 'qc'] as const

export type StageName = (typeof STAGE_ORDER)[number]

export interface JobContext {
  time: import('../time.js').TimeSource
  signal?: AbortSignal
  assertOwned?: () => void
  attemptId?: string
  jobId: string
  db: Database
  channel: ChannelConfig
  topic: string
  /**
   * Set when this job renders one part of a reddit story: the script stage
   * narrates `bodyText` verbatim instead of inventing a script from `topic`.
   * Resolved fresh on every run from the topic row `claimTopic` bound to this
   * job (see `storyPartForJob`), rather than stored on the job itself —
   * `jobs` gained no new column, so a resume recovers it for free from the
   * same row.
   */
  story?: StoryPart
  runDir: string
  artifactPath(stage: StageName, file: string): string
  log: Logger
}

export interface StageDef {
  name: StageName
  run(ctx: JobContext): Promise<void>
}
