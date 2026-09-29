import { z } from 'zod'

/** Source data captured at scouting time, independent of story-mode eligibility. */
export const sourcePostSchema = z.object({
  version: z.literal(1),
  title: z.string(),
  body: z.string().nullable(),
  author: z.string().nullable(),
  publishedAt: z.string().nullable(),
  sourceId: z.string(),
  externalId: z.string().nullable(),
  url: z.string(),
  targetUrl: z.string().nullable(),
  fetchedAt: z.string(),
})

export type SourcePost = z.infer<typeof sourcePostSchema>

export const contextSnapshotSchema = z.object({
  version: z.literal(1),
  collectedAt: z.string(),
  topic: z.string(),
  source: sourcePostSchema.nullable(),
  article: z
    .object({
      url: z.string(),
      title: z.string().nullable(),
      body: z.string().nullable(),
      author: z.string().nullable(),
      publishedAt: z.string().nullable(),
      excerpt: z.string().nullable(),
    })
    .nullable(),
  warnings: z.array(z.string()),
  promptContext: z.string(),
  truncation: z.object({ post: z.boolean(), article: z.boolean() }),
})

export type ContextSnapshot = z.infer<typeof contextSnapshotSchema>

export function parseSourcePost(raw: string | null): SourcePost | null {
  if (raw === null) return null
  try {
    const parsed = sourcePostSchema.safeParse(JSON.parse(raw))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}
