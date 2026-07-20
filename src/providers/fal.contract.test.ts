import 'dotenv/config';
import { describe, it, expect } from 'vitest';
import { mkdtempSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generateImage, animateImage } from './fal.js';
import { probe } from '../media/ffmpeg.js';

// Runs only via `pnpm test:contract` (CONTRACT=1; excluded from default
// `pnpm test`). Makes real fal.ai calls; needs FAL_KEY (shell env or .env —
// loaded here because vitest does not read .env on its own).
// Spend: FLUX keyframe $0.05 + MiniMax 512P 6s clip ~$0.10 => ~$0.15.
// The Kling block adds ~$0.42 and only runs when CONTRACT_PREMIUM=1 is also set.
const dir = mkdtempSync(path.join(os.tmpdir(), 'brainrot-fal-contract-'));
const keyframePath = path.join(dir, 'keyframe.png');

describe.skipIf(!process.env.FAL_KEY)('fal adapter (contract)', () => {
  it('generates a real FLUX 9:16 keyframe', async () => {
    const { costUsdMicros } = await generateImage({
      model: 'fal-ai/flux/dev',
      prompt: 'A lighthouse on a rocky cliff at dusk, dramatic clouds, cinematic lighting, vertical composition',
      outPath: keyframePath,
    });
    // A real 768x1344 png is far larger than any error payload could be.
    expect(statSync(keyframePath).size).toBeGreaterThan(50_000);
    expect(costUsdMicros).toBe(50_000);
  }, 180_000);

  it('animates the keyframe via MiniMax into a decodable 9:16 clip', async () => {
    const outPath = path.join(dir, 'clip-minimax.mp4');
    const { costUsdMicros } = await animateImage({
      model: 'fal-ai/minimax/hailuo-02/standard/image-to-video',
      imagePath: keyframePath,
      motionPrompt: 'slow gentle zoom toward the lighthouse, clouds drifting',
      durationSec: 5,
      outPath,
    });
    const clip = await probe(outPath);
    expect(clip.durationMs).toBeGreaterThanOrEqual(4_000); // a 5s request renders ~6s on this endpoint
    expect(clip.height).toBeGreaterThan(clip.width); // 9:16 inherited from the keyframe
    expect(costUsdMicros).toBe(102_000);
  }, 600_000);
});

// A real Kling v3 standard clip costs ~$0.42 — opt in separately.
describe.skipIf(process.env.CONTRACT_PREMIUM !== '1' || !process.env.FAL_KEY)('fal adapter (contract, premium)', () => {
  it('animates the keyframe via Kling v3 standard', async () => {
    const outPath = path.join(dir, 'clip-kling.mp4');
    const { costUsdMicros } = await animateImage({
      model: 'fal-ai/kling-video/v3/standard/image-to-video',
      imagePath: keyframePath,
      motionPrompt: 'slow dolly toward the lighthouse as waves crash below',
      durationSec: 5,
      outPath,
    });
    const clip = await probe(outPath);
    expect(clip.durationMs).toBeGreaterThanOrEqual(4_000);
    expect(clip.height).toBeGreaterThan(clip.width);
    expect(costUsdMicros).toBe(420_000);
  }, 600_000);
});
