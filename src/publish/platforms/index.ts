import type { Platform, PublishAdapter } from '../types.js'
import { instagramAdapter } from './instagram.js'
import { youtubeAdapter } from './youtube.js'

// Adding platform #3 is one adapter module plus one line here (design spec
// decision 8) — publish-next.ts drives this generically over
// PUBLISH_PLATFORMS and never imports a platform module directly.
export const ADAPTERS: Record<Platform, (fetchImpl?: typeof fetch) => PublishAdapter> = {
  youtube: youtubeAdapter,
  instagram: instagramAdapter,
}
