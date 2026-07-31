import type { Platform, PlatformQuota } from '../types.js'

/**
 * Per-platform quota SCOPE — the one fact about platform limits that stays
 * ours to declare. The limits themselves are the platform's: an upload the
 * API refuses with a quota error backs the platform off for QUOTA_BACKOFF_MS
 * (src/publish/publishes.ts) rather than being pre-counted against a local
 * cap. 'global' = one shared pool across every channel (YouTube: per Google
 * Cloud project); 'channel' = one pool per channel (Instagram: per account).
 */
export const PLATFORM_QUOTAS: Record<Platform, PlatformQuota> = {
  youtube: { scope: 'global' },
  instagram: { scope: 'channel' },
}
