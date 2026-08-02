/**
 * The platforms a channel can target. TikTok is here and was not in the old
 * PUBLISH_PLATFORMS for exactly one reason: there was no upload adapter for
 * it. The script stage has always written TikTok metadata
 * (src/stages/script.ts's platformMetaSchema), and posting by hand needs no
 * adapter, so the exclusion no longer means anything.
 */
export const PLATFORMS = ['youtube', 'instagram', 'tiktok'] as const

export type Platform = (typeof PLATFORMS)[number]

export function isPlatform(value: unknown): value is Platform {
  return typeof value === 'string' && (PLATFORMS as readonly string[]).includes(value)
}
