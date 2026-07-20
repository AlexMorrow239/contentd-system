import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import type Anthropic from '@anthropic-ai/sdk';
import { structuredCompletion } from './anthropic.js';

const schema = z.object({ answer: z.string(), n: z.number() });

function fakeClient(response: unknown): { client: Anthropic; create: ReturnType<typeof vi.fn> } {
  const create = vi.fn().mockResolvedValue(response);
  return { client: { messages: { create } } as unknown as Anthropic, create };
}

describe('structuredCompletion', () => {
  it('parses the emit tool input, computes cost, and passes a native JSON schema', async () => {
    const { client, create } = fakeClient({
      content: [{ type: 'tool_use', name: 'emit', id: 't1', input: { answer: 'hi', n: 3 } }],
      usage: { input_tokens: 100, output_tokens: 200 },
    });
    const { data, cost } = await structuredCompletion({ model: 'claude-sonnet-5', system: 's', prompt: 'p', schema, client });
    expect(data).toEqual({ answer: 'hi', n: 3 });
    expect(cost.usdMicros).toBe(100 * 3 + 200 * 15); // 3300

    // The forced emit tool must carry the zod schema rendered to JSON Schema.
    const sentTool = create.mock.calls[0][0].tools[0];
    expect(sentTool.name).toBe('emit');
    expect(sentTool.input_schema.type).toBe('object');
    expect(sentTool.input_schema.required).toEqual(expect.arrayContaining(['answer', 'n']));
  });

  it('throws a zod error on malformed tool input', async () => {
    const { client } = fakeClient({
      content: [{ type: 'tool_use', name: 'emit', id: 't1', input: { answer: 'hi' } }],
      usage: { input_tokens: 10, output_tokens: 10 },
    });
    await expect(structuredCompletion({ model: 'claude-sonnet-5', system: 's', prompt: 'p', schema, client })).rejects.toThrow(z.ZodError);
  });

  it('coerces a JSON-stringified nested value before validating (observed real-model behavior)', async () => {
    const arraySchema = z.object({ segments: z.array(z.object({ text: z.string() })) });
    const { client } = fakeClient({
      content: [
        {
          type: 'tool_use',
          name: 'emit',
          id: 't1',
          // Anthropic tool_choice does not guarantee schema-conformant output;
          // models occasionally stringify a nested array/object instead of
          // emitting it structurally. Reproduces a failure seen against the
          // real API where `segments` came back as a JSON string.
          input: { segments: JSON.stringify([{ text: 'a' }, { text: 'b' }]) },
        },
      ],
      usage: { input_tokens: 10, output_tokens: 10 },
    });
    const { data } = await structuredCompletion({ model: 'claude-sonnet-5', system: 's', prompt: 'p', schema: arraySchema, client });
    expect(data).toEqual({ segments: [{ text: 'a' }, { text: 'b' }] });
  });

  it('still throws on genuinely malformed input (not a JSON string, just wrong)', async () => {
    const arraySchema = z.object({ segments: z.array(z.object({ text: z.string() })) });
    const { client } = fakeClient({
      content: [{ type: 'tool_use', name: 'emit', id: 't1', input: { segments: 'not json at all' } }],
      usage: { input_tokens: 10, output_tokens: 10 },
    });
    await expect(
      structuredCompletion({ model: 'claude-sonnet-5', system: 's', prompt: 'p', schema: arraySchema, client }),
    ).rejects.toThrow(z.ZodError);
  });

  it('throws when there is no emit tool_use block', async () => {
    const { client } = fakeClient({ content: [{ type: 'text', text: 'nope' }], usage: { input_tokens: 1, output_tokens: 1 } });
    await expect(structuredCompletion({ model: 'claude-sonnet-5', system: 's', prompt: 'p', schema, client })).rejects.toThrow(/no emit tool_use/);
  });

  it('rejects an unpriced model at zero spend, before the API is called', async () => {
    const { client, create } = fakeClient({
      content: [{ type: 'tool_use', name: 'emit', id: 't1', input: { answer: 'hi', n: 3 } }],
      usage: { input_tokens: 100, output_tokens: 200 },
    });
    await expect(
      structuredCompletion({ model: 'claude-nonexistent-9', system: 's', prompt: 'p', schema, client }),
    ).rejects.toThrow(/no price table entry for model/);
    // The paid call must never fire for a model we cannot price.
    expect(create).not.toHaveBeenCalled();
  });
});
