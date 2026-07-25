import { z } from 'zod'

// The shape of one platform's entry in library.metadata_json's per-platform
// map — written by the script stage (src/stages/script.ts) and read back by
// the publish tick (resolvePlatformMeta in ./types.ts). Both sides share this
// one definition: a one-sided tighten would silently route valid rows to the
// synthesized-fallback title path instead of failing loudly.
export const platformEntrySchema = z.object({
  title: z.string(),
  description: z.string(),
  hashtags: z.array(z.string()),
})

export type PlatformMeta = z.infer<typeof platformEntrySchema>
