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

  it('throws when there is no emit tool_use block', async () => {
    const { client } = fakeClient({ content: [{ type: 'text', text: 'nope' }], usage: { input_tokens: 1, output_tokens: 1 } });
    await expect(structuredCompletion({ model: 'claude-sonnet-5', system: 's', prompt: 'p', schema, client })).rejects.toThrow(/no emit tool_use/);
  });
});
