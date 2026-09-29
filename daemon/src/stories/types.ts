// The story payload one job renders: one part of one reddit post.
//
// Lives in daemon/src/stories/ because both daemon/src/jobs/types.ts (JobContext) and
// daemon/src/scout/topics.ts (the DAO that reads it back) need it, and this module
// imports nothing — so neither of them acquires a dependency on the other.

export interface StoryPart {
  /** Narratable text for THIS part, pre-sanitization. */
  bodyText: string
  /** 1-based. */
  partIndex: number
  partCount: number
  /** The reddit comments permalink, for the truncation outro. */
  sourceUrl: string
  /** Whether the whole series was cut short by max_parts. */
  truncated: boolean
}
