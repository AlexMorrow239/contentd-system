import { promises as fs } from 'node:fs'
import { z } from 'zod'
import type Anthropic from '@anthropic-ai/sdk'
import type { StageDef, JobContext } from '../jobs/types.js'
import { assertBudget, recordCost } from '../jobs/costs.js'
import { structuredCompletion } from '../providers/anthropic.js'
import { errorCostUsdMicros } from '../providers/errors.js'
import { platformEntrySchema } from '../publish/platform-meta.js'
import { sanitizeStory } from '../stories/sanitize.js'
import type { StoryPart } from '../stories/types.js'

// Pre-flight budget reservation for the script LLM call (~$0.02). assertBudget
// blocks the stage if the job or day is already too close to its cap.
//
// This is a TYPICAL-cost reservation, not a worst-case one: at maxTokens 4096 a
// fully-saturated response costs ~65k micros (4096 output tokens x $15/MTok plus
// input), well above this estimate. The overshoot is bounded to a single call,
// fully ledgered from response.usage after it returns, and caught at the next
// stage's budget gate — so a rare oversized script cannot silently escape the
// caps, it just parks the job 'blocked' one stage later.
export const ESTIMATED_SCRIPT_COST_MICROS = 20_000

const platformMetaSchema = z.object({
  youtube: platformEntrySchema,
  tiktok: platformEntrySchema,
  instagram: platformEntrySchema,
})

// Mirrors the contract's ScriptOutput exactly (no length constraints — those
// are enforced by the prompt, keeping the tool input_schema constraint-free).
export const ScriptOutputSchema = z.object({
  hook: z.string(),
  segments: z.array(z.object({ text: z.string(), visualDirection: z.string() })),
  platformMeta: platformMetaSchema,
})

export type ScriptOutput = z.infer<typeof ScriptOutputSchema>
export type ScriptArtifact = ScriptOutput

// Story mode makes ONE model call, and it writes only platformMeta — narration
// is assembled deterministically, so verbatim is guaranteed by construction
// rather than by prompt discipline. Haiku because three short strings do not
// need Sonnet; ~$0.001 against the topic path's ~$0.02.
export const STORY_META_MODEL = 'claude-haiku-4-5'
export const ESTIMATED_STORY_META_COST_MICROS = 2_000

// How much of the story's opening the metadata call sees. Enough for a
// specific title and hashtags, bounded so an r/nosleep post cannot balloon the
// prompt. Narration does not come from this call — storyMetaSchema accepts
// only platformMeta — so the model seeing the opening cannot affect what is
// spoken.
export const STORY_META_PREVIEW_WORDS = 60

const STORY_OUTRO = 'The full story is linked in the description.'
const PART_WORDS = ['', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight']

// visualDirection has no consumer — visuals-volume.ts picks a random
// background clip regardless — so story segments carry a constant rather than
// paying a model to invent phrases nothing reads.
const STORY_VISUAL = 'story background'

/**
 * The spoken opener. Part 1 uses the post's own title, which in this genre is
 * already the hook ("AITA for blocking a car in?"); the `(1/3)` suffix the
 * scout appended for the queue is stripped, since it is not speech. Later
 * parts get a short continuation line so voice.ts's HOOK_PAUSE_MS lands
 * naturally before the narration resumes.
 */
function storyHook(topic: string, part: StoryPart): string {
  if (part.partIndex > 1) {
    const word = PART_WORDS[part.partIndex] ?? String(part.partIndex)
    return `Part ${word}.`
  }
  return topic.replace(/\s*\(\d+\/\d+\)\s*$/, '').trim()
}

/**
 * Paragraphs become segments. Sanitization runs here, on the way into the
 * artifact, so the caption text and the spoken audio are the same string —
 * captions render script.json's segments, so substituting anywhere later would
 * desynchronize them.
 */
function storySegments(part: StoryPart): { text: string; visualDirection: string }[] {
  const segments = sanitizeStory(part.bodyText)
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter((p) => p !== '')
    .map((text) => ({ text, visualDirection: STORY_VISUAL }))
  // Only the LAST part of a series that was cut short says so.
  if (part.truncated && part.partIndex === part.partCount) {
    segments.push({ text: STORY_OUTRO, visualDirection: STORY_VISUAL })
  }
  return segments
}

const storyMetaSchema = z.object({ platformMeta: platformMetaSchema })

/**
 * The first STORY_META_PREVIEW_WORDS words of the sanitized body, ellipsized
 * if cut short. Sanitized so the preview never hands the model a raw flagged
 * word it might then echo back into published metadata (see sanitizeStory
 * call below, which is the actual guarantee — this just avoids modeling on
 * words we'd have to substitute anyway).
 */
function storyOpeningPreview(part: StoryPart): string {
  const words = sanitizeStory(part.bodyText).split(/\s+/).filter((w) => w !== '')
  const preview = words.slice(0, STORY_META_PREVIEW_WORDS).join(' ')
  return words.length > STORY_META_PREVIEW_WORDS ? `${preview}…` : preview
}

function buildStoryMetaPrompt(topic: string, part: StoryPart): string {
  return `Write publishing metadata for one part of a narrated reddit story video.

Video title context: ${topic}
This is part ${part.partIndex} of ${part.partCount}.

Story opening (for context only — do NOT write or summarize the story itself, the narration is fixed and is not your job):
${storyOpeningPreview(part)}

platformMeta: provide entries for youtube, tiktok, and instagram. For each entry:
- title: at most 90 characters. No emojis.${
    part.partCount > 1 ? ` End the title with " (${part.partIndex}/${part.partCount})".` : ''
  }
- description: 1 to 2 plain-spoken sentences. No emojis.
- hashtags: at most 5 hashtags, each starting with "#", lowercase, no spaces.

Tone: plain-spoken. Do not use emojis anywhere. Do not use markdown.`
}

function buildSystem(niche: string[]): string {
  return [
    `You are an expert short-form video scriptwriter for the "${niche.join(', ')}" niche.`,
    'You write punchy, retention-optimized narration for 9:16 vertical videos published to YouTube Shorts, TikTok, and Instagram Reels.',
    'Use the story format: one strong hook, then a single narrative arc across the segments.',
    'Return your answer ONLY by calling the `emit` tool. Never write prose or markdown.',
  ].join(' ')
}

function buildPrompt(topic: string, niche: string[]): string {
  return `Write a short-form video script about: ${topic}

Niche: ${niche.join(', ')}

Story-format requirements:
- hook: one line, at most 10 words, that stops the scroll. No emojis.
- segments: 4 to 8 segments forming one narrative arc. Each segment has:
  - text: 1 to 3 sentences of spoken narration. Plain and conversational, no stage directions.
  - visualDirection: a short phrase (3 to 8 words) naming the on-screen background visual for that segment.
- platformMeta: provide entries for youtube, tiktok, and instagram. For each entry:
  - title: at most 90 characters. No emojis.
  - description: 1 to 2 plain-spoken sentences. No emojis.
  - hashtags: at most 5 hashtags, each starting with "#", lowercase, no spaces.

Tone: plain-spoken and factual. Do not use emojis anywhere. Do not use markdown.`
}

export function createScriptStage(client?: Anthropic): StageDef {
  return {
    name: 'script',
    async run(ctx: JobContext): Promise<void> {
      const artifact =
        ctx.story === undefined
          ? await runTopicScript(ctx, client)
          : await runStoryScript(ctx, ctx.story, client)
      await fs.writeFile(
        ctx.artifactPath('script', 'script.json'),
        JSON.stringify(artifact, null, 2),
      )
    },
  }
}

export const scriptStage = createScriptStage()

async function runTopicScript(ctx: JobContext, client?: Anthropic): Promise<ScriptArtifact> {
  assertBudget(ctx.db, ctx.channel, ctx.jobId, ESTIMATED_SCRIPT_COST_MICROS)
  try {
    const { data, cost } = await structuredCompletion({
      model: ctx.channel.scriptModel,
      system: buildSystem(ctx.channel.niche),
      prompt: buildPrompt(ctx.topic, ctx.channel.niche),
      schema: ScriptOutputSchema,
      maxTokens: 4096,
      client,
    })
    recordCost(ctx.db, ctx.jobId, 'anthropic', 'script', cost.usdMicros)
    return data
  } catch (err) {
    // A schema-invalid response is still a paid call: the adapter attaches the
    // billed cost to the thrown error, so ledger it here before rethrowing so
    // the spend is never lost, then let the stage fail as before.
    const paid = errorCostUsdMicros(err)
    if (paid !== undefined) recordCost(ctx.db, ctx.jobId, 'anthropic', 'script', paid)
    throw err
  }
}

/**
 * Story mode: narration is built from the post, and the model is asked only
 * for platformMeta. The prompt does show a bounded, sanitized preview of the
 * opening (STORY_META_PREVIEW_WORDS) so titles and hashtags can be specific
 * rather than generic — but storyMetaSchema accepts only platformMeta, so the
 * model structurally cannot return narration. That, not prompt avoidance, is
 * what makes "verbatim" a guarantee rather than an instruction.
 */
async function runStoryScript(
  ctx: JobContext,
  part: StoryPart,
  client?: Anthropic,
): Promise<ScriptArtifact> {
  assertBudget(ctx.db, ctx.channel, ctx.jobId, ESTIMATED_STORY_META_COST_MICROS)
  let platformMeta: ScriptOutput['platformMeta']
  try {
    const { data, cost } = await structuredCompletion({
      model: STORY_META_MODEL,
      system:
        'You write publishing metadata for short vertical videos that narrate reddit stories. ' +
        'Return your answer ONLY by calling the `emit` tool. Never write prose or markdown.',
      prompt: buildStoryMetaPrompt(ctx.topic, part),
      schema: storyMetaSchema,
      maxTokens: 1024,
      client,
    })
    recordCost(ctx.db, ctx.jobId, 'anthropic', 'script', cost.usdMicros)
    platformMeta = data.platformMeta
  } catch (err) {
    const paid = errorCostUsdMicros(err)
    if (paid !== undefined) recordCost(ctx.db, ctx.jobId, 'anthropic', 'script', paid)
    throw err
  }

  // Published metadata and spoken audio must agree: title/description ship on
  // YouTube/Instagram as text a viewer reads, so a raw flagged word here while
  // the narration speaks the euphemism is exactly the mismatch platform
  // moderation compares against. hashtags are left alone — they are lowercase
  // tokens, not prose, and substituting inside one produces nonsense. This
  // runs before the permalink is appended below so the URL is never rewritten
  // by the substitution map.
  for (const entry of Object.values(platformMeta)) {
    entry.title = sanitizeStory(entry.title)
    entry.description = sanitizeStory(entry.description)
  }

  // A truncated series has an ending the video does not reach, so every
  // platform's description carries the permalink the outro points at.
  if (part.truncated && part.partIndex === part.partCount) {
    for (const entry of Object.values(platformMeta)) {
      entry.description = `${entry.description} Full story: ${part.sourceUrl}`
    }
  }

  return {
    hook: storyHook(ctx.topic, part),
    segments: storySegments(part),
    platformMeta,
  }
}
