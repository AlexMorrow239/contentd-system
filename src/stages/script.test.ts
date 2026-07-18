import { describe, it, expect, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import type Anthropic from '@anthropic-ai/sdk';
import { BudgetExceededError } from '../jobs/costs.js';
import { createScriptStage, ESTIMATED_SCRIPT_COST_MICROS } from './script.js';
import { makeCtx, testChannel } from './_testkit.js';

const VALID_SCRIPT = {
  hook: 'The Moon is slowly leaving us',
  segments: [
    { text: 'Every year the Moon drifts about 3.8 centimeters farther from Earth.', visualDirection: 'moon over dark ocean' },
    { text: 'Tidal forces steal energy from Earth and hand it to the Moon.', visualDirection: 'animated tidal bulge diagram' },
    { text: 'In the deep future, total solar eclipses will vanish forever.', visualDirection: 'solar eclipse timelapse' },
    { text: 'But do not worry, that is billions of years away.', visualDirection: 'calm starfield' },
  ],
  platformMeta: {
    youtube: { title: 'The Moon Is Drifting Away From Earth', description: 'The Moon moves 3.8cm farther each year. Here is why.', hashtags: ['#space', '#astronomy', '#moon'] },
    tiktok: { title: 'The Moon is leaving us', description: 'A tiny drift with a huge future consequence.', hashtags: ['#space', '#moon'] },
    instagram: { title: 'Why the Moon drifts away', description: 'Tidal forces are slowly pushing the Moon out.', hashtags: ['#space', '#astronomy'] },
  },
};

function fakeClient(response: unknown): { client: Anthropic; create: ReturnType<typeof vi.fn> } {
  const create = vi.fn().mockResolvedValue(response);
  return { client: { messages: { create } } as unknown as Anthropic, create };
}

describe('scriptStage', () => {
  it('writes script.json, records cost, and forces the emit tool with the script schema', async () => {
    const ctx = makeCtx(testChannel());
    const { client, create } = fakeClient({
      content: [{ type: 'tool_use', name: 'emit', id: 't1', input: VALID_SCRIPT }],
      usage: { input_tokens: 500, output_tokens: 800 },
    });
    await createScriptStage(client).run(ctx);

    const written = JSON.parse(await fs.readFile(ctx.artifactPath('script', 'script.json'), 'utf8'));
    expect(written).toEqual(VALID_SCRIPT);

    const rows = ctx.db.prepare('SELECT provider, operation, usd_micros FROM costs WHERE job_id = ?').all(ctx.jobId);
    expect(rows).toEqual([{ provider: 'anthropic', operation: 'script', usd_micros: 500 * 3 + 800 * 15 }]);

    // The emit tool's input_schema is the ScriptOutputSchema rendered to JSON Schema
    // by z.toJSONSchema — an object requiring hook, segments, and platformMeta.
    const sentArgs = create.mock.calls[0][0];
    expect(sentArgs.tool_choice).toEqual({ type: 'tool', name: 'emit' });
    const sentTool = sentArgs.tools[0];
    expect(sentTool.name).toBe('emit');
    expect(sentTool.input_schema.type).toBe('object');
    expect(sentTool.input_schema.required).toEqual(
      expect.arrayContaining(['hook', 'segments', 'platformMeta']),
    );
  });

  it('throws a zod error when the tool input is malformed', async () => {
    const ctx = makeCtx(testChannel());
    const { client } = fakeClient({
      content: [{ type: 'tool_use', name: 'emit', id: 't1', input: { hook: 'x' } }],
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    await expect(createScriptStage(client).run(ctx)).rejects.toThrow();
  });

  it('throws BudgetExceededError before calling the API when over budget', async () => {
    const ctx = makeCtx(testChannel({ budget: { perVideoUsdMicros: 1, perDayUsdMicros: 1 } }));
    const { client, create } = fakeClient({});
    await expect(createScriptStage(client).run(ctx)).rejects.toBeInstanceOf(BudgetExceededError);
    expect(create).not.toHaveBeenCalled();
    expect(ESTIMATED_SCRIPT_COST_MICROS).toBeGreaterThan(1);
  });
});
