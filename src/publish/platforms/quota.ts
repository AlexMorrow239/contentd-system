import { BrainrotError } from '../../errors.js'
import type { Platform, PlatformQuota } from '../types.js'

// YouTube quota is per Google Cloud project (~10k units/day, 1600/upload),
// not per channel — this is the hard pre-upload gate counted across every
// channel (design spec decision 10).
export const DEFAULT_YT_UPLOADS_PER_DAY = 6

// Instagram's Content Publishing API allows 50 API-published posts per
// rolling 24h per IG ACCOUNT, so it is counted per channel. Our own count is
// a local calendar day rather than a rolling window, which at these volumes
// (a handful of videos a day) can never approach the real limit — a config
// declaring 50/day would have to be accepted by the load-time quota check
// first, and no channel comes close.
export const DEFAULT_IG_UPLOADS_PER_DAY = 50

/**
 * One platform's `BRAINROT_*_UPLOADS_PER_DAY` override. Parsed at call time
 * (not module load) so tests and long-lived processes see env changes without
 * a re-import — same convention as costs.ts's globalDailyCapMicros.
 */
export function uploadsPerDayCap(envVar: string, fallback: number): number {
  const raw = process.env[envVar]
  if (raw === undefined || raw.trim() === '') {
    return fallback
  }
  const n = Number(raw)
  // Integer-only: the tick gates on `used >= cap`, so a fractional 1.5 would
  // permit 2 uploads — a cap that silently rounds itself up.
  if (!Number.isInteger(n) || n <= 0) {
    throw new BrainrotError(
      `invalid ${envVar}: ${JSON.stringify(raw)} (expected a positive integer number of uploads)`,
      { domain: 'config', kind: 'invalid' },
    )
  }
  return n
}

function quota(scope: PlatformQuota['scope'], envVar: string, fallback: number): PlatformQuota {
  return { scope, envVar, cap: () => uploadsPerDayCap(envVar, fallback) }
}

export function ytUploadsPerDayCap(): number {
  return uploadsPerDayCap('BRAINROT_YT_UPLOADS_PER_DAY', DEFAULT_YT_UPLOADS_PER_DAY)
}

export function igUploadsPerDayCap(): number {
  return uploadsPerDayCap('BRAINROT_IG_UPLOADS_PER_DAY', DEFAULT_IG_UPLOADS_PER_DAY)
}

/**
 * Every platform's quota descriptor, as plain data. Each adapter exposes its
 * own entry as `adapter.quota`, so the publish tick's quota gate and every
 * reader below see one definition rather than mirrored copies that could
 * silently drift.
 *
 * This is a leaf module on purpose: readers that only need the descriptor
 * (the read-only dashboard, the digest, publish-next's env pre-check) import
 * it directly instead of constructing an adapter — no upload mechanics, no
 * credential code, no per-read allocation.
 */
export const PLATFORM_QUOTAS: Record<Platform, PlatformQuota> = {
  youtube: quota('global', 'BRAINROT_YT_UPLOADS_PER_DAY', DEFAULT_YT_UPLOADS_PER_DAY),
  instagram: quota('channel', 'BRAINROT_IG_UPLOADS_PER_DAY', DEFAULT_IG_UPLOADS_PER_DAY),
}
