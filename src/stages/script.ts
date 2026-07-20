import { promises as fs } from 'node:fs';
import { z } from 'zod';
import type Anthropic from '@anthropic-ai/sdk';
import type { StageDef, JobContext } from '../jobs/types.js';
import { assertBudget, recordCost } from '../jobs/costs.js';
import { structuredCompletion } from '../providers/anthropic.js';
import { errorCostUsdMicros } from '../providers/errors.js';

// Pre-flight budget reservation for the script LLM call (~$0.02). assertBudget
// blocks the stage if the job or day is already too close to its cap.
//
// This is a TYPICAL-cost reservation, not a worst-case one: at maxTokens 4096 a
// fully-saturated response costs ~65k micros (4096 output tokens x $15/MTok plus
// input), well above this estimate. The overshoot is bounded to a single call,
// fully ledgered from response.usage after it returns, and caught at the next
// stage's budget gate — so a rare oversized script cannot silently escape the
// caps, it just parks the job 'blocked' one stage later.
export const ESTIMATED_SCRIPT_COST_MICROS = 20_000;

const platformEntrySchema = z.object({
  title: z.string(),
  description: z.string(),
  hashtags: z.array(z.string()),
});

// Shared by both output formats: platformMeta rules are identical for story
// and scenes scripts.
const platformMetaSchema = z.object({
  youtube: platformEntrySchema,
  tiktok: platformEntrySchema,
  instagram: platformEntrySchema,
});

// Mirrors the contract's ScriptOutput exactly (no length constraints — those
// are enforced by the prompt, keeping the tool input_schema constraint-free).
export const ScriptOutputSchema = z.object({
  hook: z.string(),
  segments: z.array(z.object({ text: z.string(), visualDirection: z.string() })),
  platformMeta: platformMetaSchema,
});

export type ScriptOutput = z.infer<typeof ScriptOutputSchema>;

// LLM-facing schema for the premium `scenes` format. Deliberately carries NO
// `format` field: the model never sees or emits it. The stage stamps
// `format: 'scenes'` onto the validated payload when writing script.json so
// downstream stages can discriminate the two artifact shapes; volume
// script.json stays exactly as in Plan 1 (no format field).
export const ScenesOutputSchema = z.object({
  // .min(1) on every free-text field: an empty narration (or style/prompt) is
  // never a valid scenes script and, left unchecked, an empty narration collapses
  // that scene's timing window to zero and drives wasted premium spend
  // downstream. Reject it at the schema so it fails at the script stage, at zero
  // visual spend.
  hook: z.string().min(1),
  styleBlock: z.string().min(1),
  scenes: z.array(
    z.object({
      narration: z.string().min(1),
      visualPrompt: z.string().min(1),
      motionPrompt: z.string().min(1),
    }),
  ),
  platformMeta: platformMetaSchema,
});

export type ScenesOutput = z.infer<typeof ScenesOutputSchema> & { format: 'scenes' };
export type ScriptArtifact = ScriptOutput | ScenesOutput;

export function isScenesOutput(s: ScriptArtifact): s is ScenesOutput {
  return 'format' in s && s.format === 'scenes';
}

function buildSystem(niche: string[]): string {
  return [
    `You are an expert short-form video scriptwriter for the "${niche.join(', ')}" niche.`,
    'You write punchy, retention-optimized narration for 9:16 vertical videos published to YouTube Shorts, TikTok, and Instagram Reels.',
    'Use the story format: one strong hook, then a single narrative arc across the segments.',
    'Return your answer ONLY by calling the `emit` tool. Never write prose or markdown.',
  ].join(' ');
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

Tone: plain-spoken and factual. Do not use emojis anywhere. Do not use markdown.`;
}

function buildScenesSystem(niche: string[]): string {
  return [
    `You are an expert short-form video scriptwriter for the "${niche.join(', ')}" niche.`,
    'You write punchy, retention-optimized narration for 9:16 vertical videos published to YouTube Shorts, TikTok, and Instagram Reels.',
    'Use the scenes format: one strong hook, a single visual style for the whole video, then a sequence of scenes, each pairing spoken narration with an AI image-generation prompt and a motion prompt.',
    'Return your answer ONLY by calling the `emit` tool. Never write prose or markdown.',
  ].join(' ');
}

function buildScenesPrompt(topic: string, niche: string[], stylePrefix?: string): string {
  const styleSeed = stylePrefix
    ? `Base the styleBlock on this channel style seed, keeping it clearly recognizable: ${stylePrefix}`
    : 'Choose a visual style that fits the topic and niche.';
  return `Write a scene-based short-form video script about: ${topic}

Niche: ${niche.join(', ')}

Scenes-format requirements:
- hook: one line, at most 10 words, that stops the scroll. No emojis.
- styleBlock: one paragraph defining the video's consistent visual identity — palette, medium, mood, and lighting. Every scene's keyframe image is generated with this exact paragraph prepended, so it must read as a reusable style description, not scene content. ${styleSeed}
- scenes: 5 to 8 scenes forming one narrative arc. Each scene has:
  - narration: 1 to 2 sentences of spoken narration; aim for 10 to 14 words, and never exceed 18 words total, so the spoken scene fits inside a 10-second clip. Plain and conversational, no stage directions.
  - visualPrompt: a concrete single-shot image description — subject, setting, composition. Describe one still frame only; no camera moves, no motion words.
  - motionPrompt: a short phrase describing how the shot moves — camera motion or subject motion (for example "slow push-in" or "waves rolling toward the shore").
- platformMeta: provide entries for youtube, tiktok, and instagram. For each entry:
  - title: at most 90 characters. No emojis.
  - description: 1 to 2 plain-spoken sentences. No emojis.
  - hashtags: at most 5 hashtags, each starting with "#", lowercase, no spaces.

Tone: plain-spoken and factual. Do not use emojis anywhere. Do not use markdown.`;
}

export function createScriptStage(client?: Anthropic): StageDef {
  return {
    name: 'script',
    async run(ctx: JobContext): Promise<void> {
      assertBudget(ctx.db, ctx.channel, ctx.jobId, ESTIMATED_SCRIPT_COST_MICROS, ctx.tier);
      let artifact: ScriptArtifact;
      let costUsdMicros: number;
      try {
        if (ctx.tier === 'premium') {
          const { data, cost } = await structuredCompletion({
            model: ctx.channel.scriptModel,
            system: buildScenesSystem(ctx.channel.niche),
            prompt: buildScenesPrompt(ctx.topic, ctx.channel.niche, ctx.channel.premium.stylePrefix),
            schema: ScenesOutputSchema,
            // Raise the ceiling above the 2048 default: a full script + platformMeta for
            // three platforms can exceed it, and a truncated forced tool_use surfaces as
            // an opaque ZodError rather than a clear length failure.
            maxTokens: 4096,
            client,
          });
          // The LLM never emits `format`; stamp it here so every consumer of
          // script.json can discriminate scenes vs story artifacts.
          artifact = { ...data, format: 'scenes' };
          costUsdMicros = cost.usdMicros;
        } else {
          const { data, cost } = await structuredCompletion({
            model: ctx.channel.scriptModel,
            system: buildSystem(ctx.channel.niche),
            prompt: buildPrompt(ctx.topic, ctx.channel.niche),
            schema: ScriptOutputSchema,
            maxTokens: 4096,
            client,
          });
          artifact = data;
          costUsdMicros = cost.usdMicros;
        }
      } catch (err) {
        // A schema-invalid response is still a paid call: the adapter attaches the
        // billed cost to the thrown error, so ledger it here before rethrowing so
        // the spend is never lost, then let the stage fail as before.
        const paid = errorCostUsdMicros(err);
        if (paid !== undefined) recordCost(ctx.db, ctx.jobId, 'anthropic', 'script', paid);
        throw err;
      }
      recordCost(ctx.db, ctx.jobId, 'anthropic', 'script', costUsdMicros);
      await fs.writeFile(ctx.artifactPath('script', 'script.json'), JSON.stringify(artifact, null, 2));
    },
  };
}

export const scriptStage = createScriptStage();
