import { describe, it, expect, vi, beforeEach } from 'vitest';
import { existsSync, promises as fs } from 'node:fs';

// Module mocks are hoisted above the imports below. The anthropic factory also
// stubs structuredCompletion: script.ts (imported for isScenesOutput) pulls it
// from the same module, and vitest 4 fails the import graph when a mocked
// module lacks an export that anything in the graph imports.
vi.mock('../providers/fal.js', () => ({
  estimateImageCostMicros: vi.fn(() => 30_000),
  estimateVideoCostMicros: vi.fn((_model: string, durationSec: number) => durationSec * 70_000),
  generateImage: vi.fn(),
  animateImage: vi.fn(),
}));
vi.mock('../providers/anthropic.js', () => ({
  visionJudgment: vi.fn(),
  structuredCompletion: vi.fn(),
}));

import { animateImage, estimateImageCostMicros, estimateVideoCostMicros, generateImage } from '../providers/fal.js';
import { visionJudgment } from '../providers/anthropic.js';
import { BudgetExceededError } from '../jobs/costs.js';
import {
  ESTIMATED_VISION_COST_MICROS,
  mapWithConcurrency,
  visualsPremiumStage,
  type ScenesManifest,
} from './visuals-premium.js';
import { makeCtx, testChannel, testScript } from './_testkit.js';
import type { ScenesOutput } from './script.js';
import type { ChannelConfig } from '../config/channel.js';
import type { JobContext } from '../jobs/types.js';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// The mocks never decode files, so magic-number-only bytes are enough.
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
const MP4_BYTES = Buffer.from([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70]);
const IMAGE_COST = 30_000; // what the mocked generateImage/estimateImageCostMicros report
const VISION_COST = 4_000; // what the mocked visionJudgment reports as actual cost
const VIDEO_COST = 350_000; // what the mocked animateImage reports

const PLATFORM_META = {
  youtube: { title: 't', description: 'd', hashtags: [] },
  tiktok: { title: 't', description: 'd', hashtags: [] },
  instagram: { title: 't', description: 'd', hashtags: [] },
};

function scenesScript(sceneCount: number): ScenesOutput {
  return {
    format: 'scenes',
    hook: 'Three impossible deep sea facts',
    styleBlock: 'Dark teal documentary style, volumetric god rays, 35mm film grain.',
    scenes: Array.from({ length: sceneCount }, (_, i) => ({
      narration: `Scene ${i + 1} narration sentence here.`,
      visualPrompt: `Visual for scene ${i + 1}`,
      motionPrompt: `Slow push-in ${i + 1}`,
    })),
    platformMeta: PLATFORM_META,
  };
}

// Test-local model ids prove the stage passes channel.premium through rather
// than hard-coding fal endpoint ids.
function premiumChannel(sceneConcurrency = 3): ChannelConfig {
  return testChannel({
    premium: { imageModel: 'test-image-model', videoModel: 'test-video-model', sceneConcurrency },
  });
}

function premiumCtx(channel: ChannelConfig = premiumChannel()): JobContext {
  // makeCtx builds a volume-tier context; the stage never reads the jobs row,
  // so overriding ctx.tier in place is sufficient and keeps _testkit untouched.
  return { ...makeCtx(channel), tier: 'premium' };
}

async function seedArtifacts(ctx: JobContext, script: object, durationMs: number): Promise<void> {
  await fs.writeFile(ctx.artifactPath('script', 'script.json'), JSON.stringify(script));
  // Empty words[] forces computeSceneWindows down its deterministic
  // proportional path (Task 12 contract), decoupling these tests from
  // aligned-matching internals.
  await fs.writeFile(ctx.artifactPath('captions', 'words.json'), JSON.stringify({ words: [] }));
  await fs.writeFile(
    ctx.artifactPath('voice', 'voice.json'),
    JSON.stringify({ provider: 'elevenlabs', voiceId: 'test-voice', durationMs }),
  );
}

async function readManifest(ctx: JobContext): Promise<ScenesManifest> {
  return JSON.parse(await fs.readFile(ctx.artifactPath('visuals', 'scenes.json'), 'utf8')) as ScenesManifest;
}

beforeEach(() => {
  // Clears calls but keeps factory implementations (estimate* stay priced).
  vi.clearAllMocks();
  vi.mocked(generateImage).mockImplementation(async ({ outPath }) => {
    await fs.writeFile(outPath, PNG_BYTES);
    return { costUsdMicros: IMAGE_COST };
  });
  vi.mocked(animateImage).mockImplementation(async ({ outPath }) => {
    await fs.writeFile(outPath, MP4_BYTES);
    return { costUsdMicros: VIDEO_COST };
  });
  vi.mocked(visionJudgment).mockResolvedValue({
    data: { pass: true, critique: '' },
    cost: { usdMicros: VISION_COST },
  });
});

describe('visualsPremiumStage', () => {
  it('generates keyframe -> vision check -> clip per scene and writes the manifest', async () => {
    const ctx = premiumCtx();
    const script = scenesScript(3);
    await seedArtifacts(ctx, script, 24_000);

    await visualsPremiumStage.run(ctx);

    const manifest = await readManifest(ctx);
    expect(manifest.method).toBe('proportional'); // empty words[] (Task 12 contract)
    expect(manifest.scenes).toHaveLength(3);
    expect(manifest.scenes[0].startMs).toBe(0);
    expect(manifest.scenes[2].endMs).toBe(24_000);
    manifest.scenes.forEach((entry, k) => {
      expect(entry.index).toBe(k + 1);
      expect(entry.keyframe).toBe(`scene-0${k + 1}.png`);
      expect(entry.clip).toBe(`scene-0${k + 1}.mp4`);
      expect(existsSync(ctx.artifactPath('visuals', entry.keyframe))).toBe(true);
      expect(existsSync(ctx.artifactPath('visuals', entry.clip))).toBe(true);
      expect(entry.clipDurationSec).toBe(entry.endMs - entry.startMs <= 5000 ? 5 : 10);
      expect(entry.imageAttempts).toBe(1);
      expect(entry.videoAttempts).toBe(1);
      expect(entry.costUsdMicros).toBe(IMAGE_COST + VISION_COST + VIDEO_COST);
      if (k > 0) expect(entry.startMs).toBe(manifest.scenes[k - 1].endMs); // exact tiling
    });

    // Keyframe prompt = styleBlock + visualPrompt; model ids come from channel.premium.
    const imageCalls = vi.mocked(generateImage).mock.calls.map((c) => c[0]);
    expect(imageCalls.map((c) => c.model)).toEqual(Array.from({ length: 3 }, () => 'test-image-model'));
    expect(imageCalls.map((c) => c.prompt)).toContain(`${script.styleBlock}\n\nVisual for scene 1`);
    expect(vi.mocked(estimateImageCostMicros)).toHaveBeenCalledWith('test-image-model');

    // Vision check: channel's script model, exactly the one keyframe attached.
    const visionCall = vi.mocked(visionJudgment).mock.calls[0][0];
    expect(visionCall.model).toBe('claude-sonnet-5');
    expect(visionCall.imagePaths).toHaveLength(1);
    expect(visionCall.imagePaths[0].endsWith('.png')).toBe(true);

    // Animate: keyframe in, window-derived native duration (6s window -> 10s clip).
    const scene2 = vi.mocked(animateImage).mock.calls.map((c) => c[0]).find((c) => c.outPath.endsWith('scene-02.mp4'));
    expect(scene2).toBeDefined();
    expect(scene2?.model).toBe('test-video-model');
    expect(scene2?.motionPrompt).toBe('Slow push-in 2');
    expect(scene2?.durationSec).toBe(10);
    expect(scene2?.imagePath.endsWith('scene-02.png')).toBe(true);
    expect(vi.mocked(estimateVideoCostMicros)).toHaveBeenCalledWith('test-video-model', 10);

    // Every paid call landed in the ledger under its provider/operation.
    const rows = ctx.db
      .prepare(
        'SELECT provider, operation, COUNT(*) AS n, SUM(usd_micros) AS total FROM costs WHERE job_id = ? GROUP BY provider, operation ORDER BY provider, operation',
      )
      .all(ctx.jobId) as { provider: string; operation: string; n: number; total: number }[];
    expect(rows).toEqual([
      { provider: 'anthropic', operation: 'keyframe-check', n: 3, total: 3 * VISION_COST },
      { provider: 'fal', operation: 'image', n: 3, total: 3 * IMAGE_COST },
      { provider: 'fal', operation: 'video', n: 3, total: 3 * VIDEO_COST },
    ]);
    expect(ESTIMATED_VISION_COST_MICROS).toBe(15_000);
  });

  it('regenerates a rejected keyframe with the critique appended, then passes', async () => {
    const ctx = premiumCtx();
    await seedArtifacts(ctx, scenesScript(1), 4_000); // 4s window -> 5s clip
    vi.mocked(visionJudgment)
      .mockResolvedValueOnce({
        data: { pass: false, critique: 'subject is missing from frame' },
        cost: { usdMicros: VISION_COST },
      })
      .mockResolvedValueOnce({ data: { pass: true, critique: '' }, cost: { usdMicros: VISION_COST } });

    await visualsPremiumStage.run(ctx);

    expect(vi.mocked(generateImage)).toHaveBeenCalledTimes(2);
    const retryPrompt = vi.mocked(generateImage).mock.calls[1][0].prompt;
    expect(retryPrompt).toContain('Visual for scene 1');
    expect(retryPrompt).toContain('subject is missing from frame');

    const manifest = await readManifest(ctx);
    expect(manifest.scenes[0].imageAttempts).toBe(2);
    expect(manifest.scenes[0].videoAttempts).toBe(1);
    expect(manifest.scenes[0].clipDurationSec).toBe(5);
    expect(manifest.scenes[0].costUsdMicros).toBe(2 * IMAGE_COST + 2 * VISION_COST + VIDEO_COST);
    expect(vi.mocked(animateImage).mock.calls[0][0].durationSec).toBe(5);
  });

  it('fails the stage after 3 rejected keyframes but still settles the other scene', async () => {
    const ctx = premiumCtx();
    await seedArtifacts(ctx, scenesScript(2), 16_000);
    vi.mocked(visionJudgment).mockImplementation(async ({ prompt }) =>
      prompt.includes('Visual for scene 1')
        ? { data: { pass: false, critique: 'wrong subject entirely' }, cost: { usdMicros: VISION_COST } }
        : { data: { pass: true, critique: '' }, cost: { usdMicros: VISION_COST } },
    );

    await expect(visualsPremiumStage.run(ctx)).rejects.toThrow(
      /scene 01: keyframe rejected after 3 attempts: wrong subject entirely/,
    );

    const scene1Calls = vi.mocked(generateImage).mock.calls.filter((c) => c[0].prompt.includes('Visual for scene 1'));
    expect(scene1Calls).toHaveLength(3);
    // Scene 2 settled: its clip landed even though the stage failed (resume checkpoint).
    expect(existsSync(ctx.artifactPath('visuals', 'scene-02.mp4'))).toBe(true);
    // No manifest on failure: a resume re-runs the stage and rebuilds it.
    expect(existsSync(ctx.artifactPath('visuals', 'scenes.json'))).toBe(false);
  });

  it('reuses a scene whose clip already exists (resume) without provider calls for it', async () => {
    const ctx = premiumCtx();
    await seedArtifacts(ctx, scenesScript(2), 16_000);
    await fs.writeFile(ctx.artifactPath('visuals', 'scene-01.mp4'), MP4_BYTES); // prior attempt's checkpoint

    await visualsPremiumStage.run(ctx);

    const outPaths = [
      ...vi.mocked(generateImage).mock.calls.map((c) => c[0].outPath),
      ...vi.mocked(animateImage).mock.calls.map((c) => c[0].outPath),
    ];
    expect(outPaths).toHaveLength(2); // one image + one video, both for scene 2
    for (const p of outPaths) expect(p).toMatch(/scene-02/);
    expect(vi.mocked(visionJudgment)).toHaveBeenCalledTimes(1);

    const manifest = await readManifest(ctx);
    expect(manifest.scenes[0]).toMatchObject({
      clip: 'scene-01.mp4',
      imageAttempts: 0,
      videoAttempts: 0,
      costUsdMicros: 0,
    });
    expect(manifest.scenes[1]).toMatchObject({ imageAttempts: 1, videoAttempts: 1 });

    const spend = ctx.db
      .prepare('SELECT COALESCE(SUM(usd_micros), 0) AS total FROM costs WHERE job_id = ?')
      .get(ctx.jobId) as { total: number };
    expect(spend.total).toBe(IMAGE_COST + VISION_COST + VIDEO_COST); // scene 2 only
  });

  it('propagates BudgetExceededError before any paid call when the premium cap is too low', async () => {
    const channel = testChannel({
      premium: { imageModel: 'test-image-model', videoModel: 'test-video-model', sceneConcurrency: 3 },
      budget: { perVideoUsdMicros: 8_000_000, premiumPerVideoUsdMicros: 10, perDayUsdMicros: 20_000_000 },
    });
    const ctx = premiumCtx(channel);
    await seedArtifacts(ctx, scenesScript(3), 24_000);

    // Real assertBudget (not mocked): tier 'premium' selects premiumPerVideoUsdMicros,
    // and the 30_000-micro image estimate exceeds the 10-micro cap immediately. If the
    // stage passed 'volume' by mistake, the 8_000_000 volume cap would let this through.
    await expect(visualsPremiumStage.run(ctx)).rejects.toBeInstanceOf(BudgetExceededError);
    expect(vi.mocked(generateImage)).not.toHaveBeenCalled();
    expect(vi.mocked(animateImage)).not.toHaveBeenCalled();
  });

  it('propagates BudgetExceededError at the animate gate after image+vision spend', async () => {
    const channel = testChannel({
      premium: { imageModel: 'test-image-model', videoModel: 'test-video-model', sceneConcurrency: 3 },
      budget: { perVideoUsdMicros: 8_000_000, premiumPerVideoUsdMicros: 100_000, perDayUsdMicros: 20_000_000 },
    });
    const ctx = premiumCtx(channel);
    await seedArtifacts(ctx, scenesScript(1), 4_000); // 4s window -> 5s clip

    // Real assertBudget again, but the cap trips one gate later: the image gate
    // reserves the 30_000-micro estimate against 0 spent (passes), the vision
    // gate reserves ESTIMATED_VISION_COST_MICROS 15_000 against the 30_000
    // already ledgered (45_000, passes), then the video gate reserves
    // 5 * 70_000 = 350_000 against the 34_000 spent so far — 384_000 blows
    // the 100_000-micro premium cap before animateImage is ever dialed.
    // (One sequential scene: each gate runs after the prior call's reservation
    // was released in `finally`, so the in-flight term is 0 at every gate here.)
    await expect(visualsPremiumStage.run(ctx)).rejects.toBeInstanceOf(BudgetExceededError);
    expect(vi.mocked(generateImage)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(visionJudgment)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(animateImage)).not.toHaveBeenCalled();

    // The image and vision spend that preceded the breach is ledgered.
    const spend = ctx.db
      .prepare('SELECT COALESCE(SUM(usd_micros), 0) AS total FROM costs WHERE job_id = ?')
      .get(ctx.jobId) as { total: number };
    expect(spend.total).toBe(IMAGE_COST + VISION_COST);
  });

  it('reserves in-flight estimates so concurrent scenes cannot jointly overshoot the cap', async () => {
    // Cap sized so ONE 30_000-micro image gate fits but two cannot both fit.
    // Scene A's gate passes (0 spent + 30_000 <= 45_000) and reserves 30_000
    // while its generateImage is in flight; scene B's gate then projects
    // 30_000 (estimate) + 30_000 (in-flight reservation) = 60_000 > 45_000 and
    // trips BEFORE generateImage is ever dialed for B. Without the reservation
    // both gates would read the same 0-spend ledger and both scenes would pay.
    // Scene A then continues alone: its vision gate projects exactly 45_000
    // (equal-to-cap passes, Task 6) and its 700_000-micro video gate trips —
    // either scene's error is a BudgetExceededError, so the stage rethrows it
    // and the runner parks the job 'blocked'.
    const channel = testChannel({
      premium: { imageModel: 'test-image-model', videoModel: 'test-video-model', sceneConcurrency: 2 },
      budget: { perVideoUsdMicros: 8_000_000, premiumPerVideoUsdMicros: 45_000, perDayUsdMicros: 20_000_000 },
    });
    const ctx = premiumCtx(channel);
    await seedArtifacts(ctx, scenesScript(2), 16_000);

    await expect(visualsPremiumStage.run(ctx)).rejects.toBeInstanceOf(BudgetExceededError);

    // Exactly one image was generated (scene A's); scene B was gated pre-call,
    // so at most one image cost row can exist in the ledger.
    expect(vi.mocked(generateImage)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(animateImage)).not.toHaveBeenCalled();
    const imageRows = ctx.db
      .prepare("SELECT COUNT(*) AS n FROM costs WHERE job_id = ? AND provider = 'fal' AND operation = 'image'")
      .get(ctx.jobId) as { n: number };
    expect(imageRows.n).toBe(1);
  });

  it('caps concurrent scene work at channel.premium.sceneConcurrency', async () => {
    const ctx = premiumCtx(premiumChannel(2));
    await seedArtifacts(ctx, scenesScript(6), 60_000);
    let inFlight = 0;
    let maxInFlight = 0;
    vi.mocked(generateImage).mockImplementation(async ({ outPath }) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await sleep(20);
      inFlight -= 1;
      await fs.writeFile(outPath, PNG_BYTES);
      return { costUsdMicros: IMAGE_COST };
    });

    await visualsPremiumStage.run(ctx);

    expect(vi.mocked(generateImage)).toHaveBeenCalledTimes(6);
    expect(maxInFlight).toBeLessThanOrEqual(2);
    expect(maxInFlight).toBeGreaterThan(1); // a cap, not full serialization
  });

  it('hard-fails on a story-format script before any provider call', async () => {
    const ctx = premiumCtx();
    await seedArtifacts(ctx, testScript(), 10_000); // volume-format script: no `format` field

    await expect(visualsPremiumStage.run(ctx)).rejects.toThrow(/scenes-format script/);
    expect(vi.mocked(generateImage)).not.toHaveBeenCalled();
  });
});

describe('mapWithConcurrency', () => {
  it('maps every item, preserving input order in the results', async () => {
    // Completion order is 1, 2, 3 (shortest sleep first); result order must be input order.
    const out = await mapWithConcurrency([3, 1, 2], 2, async (n) => {
      await sleep(n * 10);
      return n * 100;
    });
    expect(out).toEqual([300, 100, 200]);
  });

  it('never runs more than `limit` callbacks at once', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    await mapWithConcurrency(Array.from({ length: 8 }, (_, i) => i), 3, async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await sleep(10);
      inFlight -= 1;
    });
    expect(maxInFlight).toBeLessThanOrEqual(3);
    expect(maxInFlight).toBeGreaterThan(1); // it is a cap, not serialization
  });

  it('lets every item settle before rejecting with the first error', async () => {
    const started: number[] = [];
    await expect(
      mapWithConcurrency([0, 1, 2, 3], 2, async (i) => {
        started.push(i);
        await sleep(5);
        if (i === 1) throw new Error(`boom ${i}`);
        return i;
      }),
    ).rejects.toThrow('boom 1');
    // Items queued after the failing one still ran: failures must not starve
    // later scenes of their chance to land artifacts (max resume progress).
    expect(started.sort((a, b) => a - b)).toEqual([0, 1, 2, 3]);
  });
});
