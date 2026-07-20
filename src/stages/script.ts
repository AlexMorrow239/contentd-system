import { promises as fs } from 'node:fs';
import { z } from 'zod';
import type Anthropic from '@anthropic-ai/sdk';
import type { StageDef, JobContext } from '../jobs/types.js';
import { assertBudget, recordCost } from '../jobs/costs.js';
import { structuredCompletion } from '../providers/anthropic.js';

// Pre-flight budget reservation for the script LLM call (~$0.02). assertBudget
// blocks the stage if the job or day is already too close to its cap.
export const ESTIMATED_SCRIPT_COST_MICROS = 20_000;

const platformEntrySchema = z.object({
  title: z.string(),
  description: z.string(),
  hashtags: z.array(z.string()),
});

// Mirrors the contract's ScriptOutput exactly (no length constraints — those
// are enforced by the prompt, keeping the tool input_schema constraint-free).
export const ScriptOutputSchema = z.object({
  hook: z.string(),
  segments: z.array(z.object({ text: z.string(), visualDirection: z.string() })),
  platformMeta: z.object({
    youtube: platformEntrySchema,
    tiktok: platformEntrySchema,
    instagram: platformEntrySchema,
  }),
});

export type ScriptOutput = z.infer<typeof ScriptOutputSchema>;

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

export function createScriptStage(client?: Anthropic): StageDef {
  return {
    name: 'script',
    async run(ctx: JobContext): Promise<void> {
      assertBudget(ctx.db, ctx.channel, ctx.jobId, ESTIMATED_SCRIPT_COST_MICROS, ctx.tier);
      const { data, cost } = await structuredCompletion({
        model: ctx.channel.scriptModel,
        system: buildSystem(ctx.channel.niche),
        prompt: buildPrompt(ctx.topic, ctx.channel.niche),
        schema: ScriptOutputSchema,
        // Raise the ceiling above the 2048 default: a full script + platformMeta for
        // three platforms can exceed it, and a truncated forced tool_use surfaces as
        // an opaque ZodError rather than a clear length failure.
        maxTokens: 4096,
        client,
      });
      recordCost(ctx.db, ctx.jobId, 'anthropic', 'script', cost.usdMicros);
      await fs.writeFile(ctx.artifactPath('script', 'script.json'), JSON.stringify(data, null, 2));
    },
  };
}

export const scriptStage = createScriptStage();
