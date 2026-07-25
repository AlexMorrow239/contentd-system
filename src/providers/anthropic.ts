import { readFileSync } from 'node:fs';
import path from 'node:path';
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

// Recursively JSON.parse any string value that looks like a JSON array or
// object, so a model's occasional "nested value serialized as a string"
// quirk doesn't fail validation. Leaves ordinary strings untouched.
function coerceJsonStrings(value: unknown): unknown {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    // The prefix check is only a cheap filter; JSON.parse rejects the rest.
    if (!trimmed.startsWith('[') && !trimmed.startsWith('{')) return value;
    try {
      return coerceJsonStrings(JSON.parse(trimmed));
    } catch {
      return value;
    }
  }
  if (Array.isArray(value)) return value.map(coerceJsonStrings);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, coerceJsonStrings(v)]));
  }
  return value;
}

// The strict tool-schema mode rejects minimum/maximum on integer properties
// (live 400: "tools.0.custom: For 'integer' type, properties maximum, minimum
// are not supported") — and zod v4's .int() ALONE emits safe-integer
// minimum/maximum, so every integer field would trip it, explicit bounds or
// not. Strip them recursively before the schema goes on the wire; range rules
// belong in prompts and in post-response validation/normalization. Response
// validation still runs the full zod schema, bounds included.
function stripIntegerBounds(node: unknown): void {
  if (Array.isArray(node)) {
    for (const item of node) stripIntegerBounds(item);
    return;
  }
  if (!node || typeof node !== 'object') return;
  const record = node as Record<string, unknown>;
  if (record.type === 'integer') {
    delete record.minimum;
    delete record.maximum;
    delete record.exclusiveMinimum;
    delete record.exclusiveMaximum;
  }
  for (const value of Object.values(record)) stripIntegerBounds(value);
}

// Shared forced-tool core for structuredCompletion and visionJudgment. The two
// public functions differ only in how the user message content is built (plain
// prompt string vs image blocks + prompt); everything else — price lookup
// BEFORE the paid call, the forced 'emit' tool, zod validation with the
// coerceJsonStrings retry, cost math — is identical and lives here. `label`
// keeps error messages caller-specific so a failure names its entry point.
async function forcedToolCompletion<T>(opts: {
  label: 'structuredCompletion' | 'visionJudgment';
  model: string;
  system: string;
  content: string | Anthropic.ContentBlockParam[];
  schema: z.ZodType<T>;
  maxTokens?: number;
  client?: Anthropic;
}): Promise<{ data: T; cost: LlmUsageCost }> {
  const client = opts.client ?? new Anthropic();

  // Resolve the price BEFORE the paid API call: a model absent from PRICE_TABLE
  // must fail at zero spend, not after a real call whose cost can never reach the
  // ledger.
  const price = PRICE_TABLE[opts.model];
  if (!price) throw new Error(`${opts.label}: no price table entry for model "${opts.model}"`);

  // Zod v4 native JSON Schema. `reused: 'inline'` inlines any reused sub-schema so
  // the tool input_schema has no $ref (the Anthropic tool API does not resolve $ref).
  const inputSchema = z.toJSONSchema(opts.schema, { reused: 'inline' }) as Anthropic.Tool.InputSchema;
  stripIntegerBounds(inputSchema);

  const response = await client.messages.create({
    model: opts.model,
    max_tokens: opts.maxTokens ?? 2048,
    // Disable thinking: forced tool_choice is a deterministic structured
    // extraction, not a reasoning task; avoids the forced-tool/thinking
    // incompatibility and needless thinking-token spend on Sonnet 5.
    thinking: { type: 'disabled' },
    system: opts.system,
    messages: [{ role: 'user', content: opts.content }],
    tools: [
      {
        name: 'emit',
        description: 'Return the structured result. You MUST call this tool exactly once.',
        input_schema: inputSchema,
        // Constrained decoding: the API guarantees the tool input conforms to
        // input_schema. Without it, Sonnet stringifies large nested arrays (the
        // scenes format) in roughly half of forced tool calls, and hand-written
        // stringified JSON can carry typos coerceJsonStrings cannot repair
        // (observed live 2026-07-20: `"motionPrompt">` for `"motionPrompt":`).
        // The coercion retry below stays as defense in depth.
        strict: true,
      },
    ],
    tool_choice: { type: 'tool', name: 'emit' },
  });

  // Cost is fixed by the usage the paid call already reported. Compute it BEFORE
  // any inspection of the response so EVERY failure below can carry the spend to
  // the caller's ledger instead of vanishing — the messages.create call is
  // billed whether or not its content is usable.
  const cost: LlmUsageCost = { usdMicros: costMicros(price, response.usage.input_tokens, response.usage.output_tokens) };

  // Attach the already-billed cost to a thrown error so the caller can ledger
  // this paid-but-unusable response before rethrowing, without changing the
  // error's identity (callers and tests still match on `instanceof z.ZodError`).
  const withCost = <E>(err: E): E => {
    (err as E & { costUsdMicros?: number }).costUsdMicros = cost.usdMicros;
    return err;
  };

  const toolUse = response.content.find(
    (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use' && b.name === 'emit',
  );
  if (!toolUse) throw withCost(new Error(`${opts.label}: no emit tool_use block in response`));

  // Anthropic's tool_choice does not guarantee schema-conformant output (no
  // `strict` mode in this SDK version): models occasionally stringify a
  // nested array/object instead of emitting it structurally. Validate first;
  // only on failure, walk the raw input and JSON.parse any string that looks
  // like a JSON array/object, then re-validate.
  const firstAttempt = opts.schema.safeParse(toolUse.input);
  let data: T;
  if (firstAttempt.success) {
    data = firstAttempt.data;
  } else {
    const retry = opts.schema.safeParse(coerceJsonStrings(toolUse.input));
    if (!retry.success) {
      // Report the original error: it describes what the model actually sent,
      // not the rewritten value the coercion produced.
      throw withCost(firstAttempt.error);
    }
    data = retry.data;
  }
  return { data, cost };
}

export async function structuredCompletion<T>(opts: {
  model: string;
  system: string;
  prompt: string;
  schema: z.ZodType<T>;
  maxTokens?: number;
  client?: Anthropic; // injected in tests; defaults to a real client
}): Promise<{ data: T; cost: LlmUsageCost }> {
  return forcedToolCompletion({
    label: 'structuredCompletion',
    model: opts.model,
    system: opts.system,
    content: opts.prompt,
    schema: opts.schema,
    maxTokens: opts.maxTokens,
    client: opts.client,
  });
}

// media_type by extension. Verified against the Anthropic vision docs
// 2026-07-19: base64 image sources accept image/png, image/jpeg, image/gif,
// image/webp. This pipeline only ever produces PNG keyframes (Task 13) and PNG
// ffmpeg frame grabs (Task 15); jpg/jpeg is tolerated for future inputs, and
// anything else is a programmer error that must fail before any spend.
const IMAGE_MEDIA_TYPES: Record<string, 'image/png' | 'image/jpeg'> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
};

export async function visionJudgment<T>(opts: {
  model: string;
  system: string;
  prompt: string;
  imagePaths: string[];
  schema: z.ZodType<T>;
  maxTokens?: number;
  client?: Anthropic; // injected in tests; defaults to a real client
}): Promise<{ data: T; cost: LlmUsageCost }> {
  // Content layout: every image block first (base64, media_type by extension),
  // then the text prompt referencing them. Built before delegating so a missing
  // file or unsupported extension fails at zero spend, before any client work.
  const content: Anthropic.ContentBlockParam[] = opts.imagePaths.map((imagePath) => {
    const ext = path.extname(imagePath).toLowerCase();
    const mediaType = IMAGE_MEDIA_TYPES[ext];
    if (!mediaType) {
      throw new Error(
        `visionJudgment: unsupported image extension "${ext}" for "${imagePath}" (expected .png, .jpg, or .jpeg)`,
      );
    }
    return {
      type: 'image',
      source: { type: 'base64', media_type: mediaType, data: readFileSync(imagePath).toString('base64') },
    };
  });
  content.push({ type: 'text', text: opts.prompt });

  return forcedToolCompletion({
    label: 'visionJudgment',
    model: opts.model,
    system: opts.system,
    content,
    schema: opts.schema,
    maxTokens: opts.maxTokens,
    client: opts.client,
  });
}
