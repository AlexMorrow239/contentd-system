import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';

export interface LlmUsageCost {
  usdMicros: number;
}

// List prices in usd-micros per 1,000,000 tokens.
// NOTE: claude-sonnet-5 has an intro promo of $2/$10 per MTok through 2026-08-31;
// we ledger at the durable list price ($3/$15) so the cost record stays correct
// after the promo ends. ($3/MTok == 3 usd-micros/token; $15/MTok == 15.)
export const PRICE_TABLE: Record<string, { inputUsdMicrosPerMTok: number; outputUsdMicrosPerMTok: number }> = {
  'claude-sonnet-5': { inputUsdMicrosPerMTok: 3_000_000, outputUsdMicrosPerMTok: 15_000_000 },
  'claude-haiku-4-5': { inputUsdMicrosPerMTok: 1_000_000, outputUsdMicrosPerMTok: 5_000_000 },
};

type Price = { inputUsdMicrosPerMTok: number; outputUsdMicrosPerMTok: number };

function costMicros(price: Price, inputTokens: number, outputTokens: number): number {
  return (
    Math.round((inputTokens * price.inputUsdMicrosPerMTok) / 1_000_000) +
    Math.round((outputTokens * price.outputUsdMicrosPerMTok) / 1_000_000)
  );
}

export async function structuredCompletion<T>(opts: {
  model: string;
  system: string;
  prompt: string;
  schema: z.ZodType<T>;
  maxTokens?: number;
  client?: Anthropic; // injected in tests; defaults to a real client
}): Promise<{ data: T; cost: LlmUsageCost }> {
  const client = opts.client ?? new Anthropic();

  // Resolve the price BEFORE the paid API call: a model absent from PRICE_TABLE
  // must fail at zero spend, not after a real call whose cost can never reach the
  // ledger. (Previously this threw only after messages.create had already billed.)
  const price = PRICE_TABLE[opts.model];
  if (!price) throw new Error(`structuredCompletion: no price table entry for model "${opts.model}"`);

  // Zod v4 native JSON Schema. `reused: 'inline'` inlines any reused sub-schema so
  // the tool input_schema has no $ref (the Anthropic tool API does not resolve $ref).
  const inputSchema = z.toJSONSchema(opts.schema, { reused: 'inline' }) as Anthropic.Tool.InputSchema;

  const response = await client.messages.create({
    model: opts.model,
    max_tokens: opts.maxTokens ?? 2048,
    // Disable thinking: forced tool_choice is a deterministic structured
    // extraction, not a reasoning task; avoids the forced-tool/thinking
    // incompatibility and needless thinking-token spend on Sonnet 5.
    thinking: { type: 'disabled' },
    system: opts.system,
    messages: [{ role: 'user', content: opts.prompt }],
    tools: [
      {
        name: 'emit',
        description: 'Return the structured result. You MUST call this tool exactly once.',
        input_schema: inputSchema,
      },
    ],
    tool_choice: { type: 'tool', name: 'emit' },
  });

  const toolUse = response.content.find(
    (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use' && b.name === 'emit',
  );
  if (!toolUse) throw new Error('structuredCompletion: no emit tool_use block in response');

  const data = opts.schema.parse(toolUse.input); // throws ZodError on malformed input
  const cost: LlmUsageCost = { usdMicros: costMicros(price, response.usage.input_tokens, response.usage.output_tokens) };
  return { data, cost };
}
