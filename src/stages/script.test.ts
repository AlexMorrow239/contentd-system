import { describe, it, expect, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import type Anthropic from '@anthropic-ai/sdk';
import { BudgetExceededError } from '../jobs/costs.js';
import { createScriptStage, ESTIMATED_SCRIPT_COST_MICROS, ScenesOutputSchema, isScenesOutput } from './script.js';
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
    // The script stage raises max_tokens above the provider's 2048 default so a full
    // script + three-platform metadata cannot be truncated into a ZodError.
    expect(sentArgs.max_tokens).toBe(4096);
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
    const ctx = makeCtx(testChannel({ budget: { perVideoUsdMicros: 1, premiumPerVideoUsdMicros: 1, perDayUsdMicros: 1 } }));
    const { client, create } = fakeClient({});
    await expect(createScriptStage(client).run(ctx)).rejects.toBeInstanceOf(BudgetExceededError);
    expect(create).not.toHaveBeenCalled();
    expect(ESTIMATED_SCRIPT_COST_MICROS).toBeGreaterThan(1);
  });
});

const VALID_SCENES = {
  hook: 'The ocean hides a second sun',
  styleBlock:
    'Muted teal and amber palette, painterly digital illustration, melancholy documentary mood, soft volumetric light filtering down through deep water.',
  scenes: [
    { narration: 'Sunlight only reaches the top two hundred meters of the ocean.', visualPrompt: 'A shaft of sunlight piercing dark blue open water, small fish silhouetted, wide composition', motionPrompt: 'slow push-in' },
    { narration: 'Below that, life makes its own light.', visualPrompt: 'A bioluminescent jellyfish glowing blue-green in pitch-black water, centered composition', motionPrompt: 'jellyfish pulsing gently' },
    { narration: 'Nine in ten deep-sea animals can glow.', visualPrompt: 'A field of scattered glowing creatures across a dark abyssal plain, wide shot', motionPrompt: 'lights twinkling in sequence' },
    { narration: 'They flash to hunt, to hide, and to find each other.', visualPrompt: 'An anglerfish with a glowing lure in total darkness, close-up composition', motionPrompt: 'lure swaying slowly' },
    { narration: 'The deep ocean is the largest lit stage on Earth.', visualPrompt: 'A vast dark seascape speckled with countless points of living light, extreme wide shot', motionPrompt: 'slow drift upward' },
  ],
  platformMeta: {
    youtube: { title: 'The Ocean Makes Its Own Light', description: 'Most deep-sea animals glow. Here is why.', hashtags: ['#ocean', '#science', '#deepsea'] },
    tiktok: { title: 'The ocean glows in the dark', description: 'Nine in ten deep-sea animals make their own light.', hashtags: ['#ocean', '#deepsea'] },
    instagram: { title: 'Why the deep ocean glows', description: 'Bioluminescence is the rule down there, not the exception.', hashtags: ['#ocean', '#science'] },
  },
};

// makeCtx hardcodes tier 'volume'; the script stage only reads ctx.tier (never
// the jobs row's tier column), so overriding the context field is sufficient.
function premiumCtx(channel = testChannel()) {
  return { ...makeCtx(channel), tier: 'premium' as const };
}

describe('ScenesOutputSchema', () => {
  it('accepts a scenes payload and rejects one missing styleBlock', () => {
    expect(ScenesOutputSchema.safeParse(VALID_SCENES).success).toBe(true);
    const { styleBlock: _omitted, ...noStyle } = VALID_SCENES;
    expect(ScenesOutputSchema.safeParse(noStyle).success).toBe(false);
  });

  it('isScenesOutput discriminates format-stamped artifacts from story artifacts', () => {
    expect(isScenesOutput({ ...VALID_SCENES, format: 'scenes' })).toBe(true);
    expect(isScenesOutput(VALID_SCRIPT)).toBe(false);
  });
});

describe('scriptStage (premium scenes)', () => {
  it('writes a format-stamped scenes script.json, records cost, and sends the scenes emit schema', async () => {
    const ctx = premiumCtx();
    const { client, create } = fakeClient({
      content: [{ type: 'tool_use', name: 'emit', id: 't1', input: VALID_SCENES }],
      usage: { input_tokens: 500, output_tokens: 800 },
    });
    await createScriptStage(client).run(ctx);

    const written = JSON.parse(await fs.readFile(ctx.artifactPath('script', 'script.json'), 'utf8'));
    expect(written).toEqual({ ...VALID_SCENES, format: 'scenes' });

    const rows = ctx.db.prepare('SELECT provider, operation, usd_micros FROM costs WHERE job_id = ?').all(ctx.jobId);
    expect(rows).toEqual([{ provider: 'anthropic', operation: 'script', usd_micros: 500 * 3 + 800 * 15 }]);

    const sentArgs = create.mock.calls[0][0];
    expect(sentArgs.tool_choice).toEqual({ type: 'tool', name: 'emit' });
    expect(sentArgs.max_tokens).toBe(4096);
    expect(sentArgs.system).toContain('scenes format');
    const sentTool = sentArgs.tools[0];
    expect(sentTool.name).toBe('emit');
    expect(sentTool.input_schema.required).toEqual(
      expect.arrayContaining(['hook', 'styleBlock', 'scenes', 'platformMeta']),
    );
    // The LLM never sees `format`: the stage stamps it after validation.
    expect(sentTool.input_schema.required).not.toContain('format');
    expect(Object.keys(sentTool.input_schema.properties)).not.toContain('format');
    // The prompt carries the constraints that keep spoken scenes coverable by 10s clips.
    expect(sentArgs.messages[0].content).toContain('at most 18 words');
    expect(sentArgs.messages[0].content).toContain('5 to 8 scenes');
  });

  it('seeds the styleBlock instruction with channel.premium.stylePrefix when set', async () => {
    const base = testChannel();
    const ctx = premiumCtx(
      testChannel({ premium: { ...base.premium, stylePrefix: 'gritty 1980s VHS documentary' } }),
    );
    const { client, create } = fakeClient({
      content: [{ type: 'tool_use', name: 'emit', id: 't1', input: VALID_SCENES }],
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    await createScriptStage(client).run(ctx);
    expect(create.mock.calls[0][0].messages[0].content).toContain('gritty 1980s VHS documentary');
  });

  it('uses a generic style instruction when stylePrefix is absent', async () => {
    const base = testChannel();
    // Build premium explicitly without stylePrefix so this test cannot be
    // affected by whatever default testChannel carries.
    const ctx = premiumCtx(
      testChannel({
        premium: {
          imageModel: base.premium.imageModel,
          videoModel: base.premium.videoModel,
          sceneConcurrency: base.premium.sceneConcurrency,
        },
      }),
    );
    const { client, create } = fakeClient({
      content: [{ type: 'tool_use', name: 'emit', id: 't1', input: VALID_SCENES }],
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    await createScriptStage(client).run(ctx);
    const prompt = create.mock.calls[0][0].messages[0].content as string;
    expect(prompt).toContain('Choose a visual style that fits the topic');
    expect(prompt).not.toContain('style seed');
  });

  it('throws BudgetExceededError against the premium per-video cap before calling the API', async () => {
    // Volume cap stays wide open (8M micros); only the premium cap (1 micro) can
    // trip — proving the stage passes ctx.tier into the Task 6 assertBudget.
    const ctx = premiumCtx(
      testChannel({
        budget: { perVideoUsdMicros: 8_000_000, premiumPerVideoUsdMicros: 1, perDayUsdMicros: 20_000_000 },
      }),
    );
    const { client, create } = fakeClient({});
    await expect(createScriptStage(client).run(ctx)).rejects.toBeInstanceOf(BudgetExceededError);
    expect(create).not.toHaveBeenCalled();
  });
});
