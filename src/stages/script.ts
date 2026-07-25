import { promises as fs } from 'node:fs';
import { z } from 'zod';
import type Anthropic from '@anthropic-ai/sdk';
import type { StageDef, JobContext } from '../jobs/types.js';
import { assertBudget, recordCost } from '../jobs/costs.js';
import { structuredCompletion } from '../providers/anthropic.js';
import { errorCostUsdMicros } from '../providers/errors.js';
import { platformEntrySchema } from '../publish/platform-meta.js';

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
export type ScriptArtifact = ScriptOutput;

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
      assertBudget(ctx.db, ctx.channel, ctx.jobId, ESTIMATED_SCRIPT_COST_MICROS);
      let artifact: ScriptArtifact;
      let costUsdMicros: number;
      try {
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
