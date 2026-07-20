import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import type Anthropic from '@anthropic-ai/sdk';
import { structuredCompletion, visionJudgment } from './anthropic.js';

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

describe('visionJudgment', () => {
  const judgmentSchema = z.object({ pass: z.boolean(), critique: z.string() });

  // Tiny fake image bytes: visionJudgment reads and base64-encodes files, it
  // never decodes them, so magic-number-only "images" are enough for unit tests.
  function writeImages(): { dir: string; pngPath: string; jpgPath: string; pngB64: string; jpgB64: string } {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'brainrot-vision-'));
    const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x01, 0x02, 0x03]);
    const jpgBytes = Buffer.from([0xff, 0xd8, 0xff, 0x04, 0x05, 0x06]);
    const pngPath = path.join(dir, 'scene-01.png');
    const jpgPath = path.join(dir, 'frame-2.JPG'); // uppercase on purpose: extension mapping is case-insensitive
    writeFileSync(pngPath, pngBytes);
    writeFileSync(jpgPath, jpgBytes);
    return { dir, pngPath, jpgPath, pngB64: pngBytes.toString('base64'), jpgB64: jpgBytes.toString('base64') };
  }

  it('sends base64 image blocks (media_type by extension) before the text prompt and parses the emit output', async () => {
    const { pngPath, jpgPath, pngB64, jpgB64 } = writeImages();
    const { client, create } = fakeClient({
      content: [{ type: 'tool_use', name: 'emit', id: 't1', input: { pass: true, critique: 'matches the scene' } }],
      usage: { input_tokens: 1000, output_tokens: 100 },
    });
    const { data, cost } = await visionJudgment({
      model: 'claude-sonnet-5',
      system: 's',
      prompt: 'Does this keyframe match the scene intent?',
      imagePaths: [pngPath, jpgPath],
      schema: judgmentSchema,
      client,
    });
    expect(data).toEqual({ pass: true, critique: 'matches the scene' });
    expect(cost.usdMicros).toBe(1000 * 3 + 100 * 15); // 4500 — same PRICE_TABLE math as structuredCompletion

    const request = create.mock.calls[0][0];
    // Shared forced-tool core: emit tool, forced tool_choice.
    expect(request.tools[0].name).toBe('emit');
    expect(request.tool_choice).toEqual({ type: 'tool', name: 'emit' });
    // Content layout: every image block precedes the single trailing text block.
    expect(request.messages[0].content).toEqual([
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: pngB64 } },
      { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: jpgB64 } },
      { type: 'text', text: 'Does this keyframe match the scene intent?' },
    ]);
  });

  it('rejects an unpriced model at zero spend, before the API is called', async () => {
    const { pngPath } = writeImages();
    const { client, create } = fakeClient({ content: [], usage: { input_tokens: 1, output_tokens: 1 } });
    await expect(
      visionJudgment({ model: 'claude-nonexistent-9', system: 's', prompt: 'p', imagePaths: [pngPath], schema: judgmentSchema, client }),
    ).rejects.toThrow(/visionJudgment: no price table entry for model/);
    expect(create).not.toHaveBeenCalled();
  });

  it('throws on an unsupported image extension without calling the API', async () => {
    const { dir } = writeImages();
    const gifPath = path.join(dir, 'frame.gif');
    writeFileSync(gifPath, Buffer.from([0x47, 0x49, 0x46]));
    const { client, create } = fakeClient({ content: [], usage: { input_tokens: 1, output_tokens: 1 } });
    await expect(
      visionJudgment({ model: 'claude-sonnet-5', system: 's', prompt: 'p', imagePaths: [gifPath], schema: judgmentSchema, client }),
    ).rejects.toThrow(/visionJudgment: unsupported image extension/);
    expect(create).not.toHaveBeenCalled();
  });

  it('coerces a JSON-stringified nested value via the shared retry path', async () => {
    const { pngPath } = writeImages();
    const listSchema = z.object({ issues: z.array(z.string()) });
    const { client } = fakeClient({
      content: [{ type: 'tool_use', name: 'emit', id: 't1', input: { issues: JSON.stringify(['caption obscures subject']) } }],
      usage: { input_tokens: 10, output_tokens: 10 },
    });
    const { data } = await visionJudgment({
      model: 'claude-sonnet-5',
      system: 's',
      prompt: 'p',
      imagePaths: [pngPath],
      schema: listSchema,
      client,
    });
    expect(data).toEqual({ issues: ['caption obscures subject'] });
  });
});
