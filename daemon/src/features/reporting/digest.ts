import type { Database } from 'better-sqlite3'
import { tryLoadChannelsDir, type ChannelConfig } from '../../config/channel.js'
import type { TimeSource } from '../../shared/time.js'
import { formatDigest } from './format.js'
import { collectDigest } from './queries.js'

/** Last-24h operator report, preserving current-state recovery and posting alerts. */
export function buildDigest(
  db: Database,
  channels: ChannelConfig[],
  opts: { channelsError?: string; time?: TimeSource } = {},
): string {
  return formatDigest(collectDigest(db, channels, opts))
}

/**
 * The digest over a channels dir that may not load. A broken dir must not take
 * the report with it: every sqlite-derived section still renders, and the
 * config failure becomes the first action item instead.
 */
export function digestForChannelsDir(
  db: Database,
  channelsDir: string,
  opts: { time?: TimeSource } = {},
): string {
  const loaded = tryLoadChannelsDir(channelsDir)
  return buildDigest(db, loaded.channels, { channelsError: loaded.error, time: opts.time })
}
