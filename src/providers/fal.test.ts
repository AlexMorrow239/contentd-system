import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  estimateImageCostMicros,
  estimateVideoCostMicros,
  generateImage,
  animateImage,
  type FalClientLike,
} from './fal.js';
import { ProviderCostError } from './errors.js';

const FLUX = 'fal-ai/flux/dev';
const KLING = 'fal-ai/kling-video/v3/standard/image-to-video';
const MINIMAX = 'fal-ai/minimax/hailuo-02/standard/image-to-video';

function fakeFal(data: Record<string, unknown>): {
  client: FalClientLike;
  subscribe: ReturnType<typeof vi.fn>;
  upload: ReturnType<typeof vi.fn>;
} {
  const subscribe = vi.fn().mockResolvedValue({ data });
  const upload = vi.fn().mockResolvedValue('https://fal.storage/uploaded-keyframe.png');
  return { client: { subscribe, storage: { upload } } as unknown as FalClientLike, subscribe, upload };
}

// Arbitrary bytes standing in for a downloaded asset.
const FILE_BYTES = new Uint8Array([137, 80, 78, 71]);

function stubDownload(): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    arrayBuffer: async () => FILE_BYTES.buffer,
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function tmpDir(): string {
  return mkdtempSync(path.join(os.tmpdir(), 'brainrot-fal-'));
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('price estimators', () => {
  it('prices a FLUX keyframe per image', () => {
    expect(estimateImageCostMicros(FLUX)).toBe(50_000); // $0.05 conservative ($0.025/MP, portrait_16_9 rounds to 2 MP)
  });

  it('prices Kling per second of requested duration', () => {
    expect(estimateVideoCostMicros(KLING, 5)).toBe(420_000); // 5 x $0.084
    expect(estimateVideoCostMicros(KLING, 10)).toBe(840_000); // 10 x $0.084
  });

  it('prices MiniMax per billed second — a 5s request renders 6s', () => {
    expect(estimateVideoCostMicros(MINIMAX, 5)).toBe(102_000); // 6 x $0.017 (endpoint has no 5s option)
    expect(estimateVideoCostMicros(MINIMAX, 10)).toBe(170_000); // 10 x $0.017
  });

  it('throws on a model missing from the price table', () => {
    expect(() => estimateImageCostMicros('fal-ai/nope')).toThrow(/no price table entry/);
    expect(() => estimateVideoCostMicros('fal-ai/nope', 5)).toThrow(/no price table entry/);
  });

  it('throws when the price kind does not match the operation', () => {
    expect(() => estimateImageCostMicros(KLING)).toThrow(/not priced per-image/);
    expect(() => estimateVideoCostMicros(FLUX, 5)).toThrow(/not priced per-second/);
  });
});

describe('generateImage', () => {
  it('sends a FLUX-family 9:16 input and downloads the image to outPath', async () => {
    const { client, subscribe } = fakeFal({ images: [{ url: 'https://fal.cdn/img.png' }] });
    const fetchMock = stubDownload();
    const outPath = path.join(tmpDir(), 'scene-01.png');

    const result = await generateImage({ model: FLUX, prompt: 'a moody lighthouse', outPath, client });

    expect(subscribe).toHaveBeenCalledWith(FLUX, {
      input: { prompt: 'a moody lighthouse', image_size: 'portrait_16_9', num_images: 1, output_format: 'png' },
    });
    expect(fetchMock).toHaveBeenCalledWith('https://fal.cdn/img.png');
    expect(readFileSync(outPath)).toEqual(Buffer.from(FILE_BYTES));
    expect(result.costUsdMicros).toBe(50_000);
  });

  it('rejects an unpriced model before any client call', async () => {
    const { client, subscribe } = fakeFal({ images: [{ url: 'https://fal.cdn/img.png' }] });
    const fetchMock = stubDownload();
    await expect(
      generateImage({ model: 'fal-ai/unknown-image', prompt: 'p', outPath: path.join(tmpDir(), 'x.png'), client }),
    ).rejects.toThrow(/no price table entry/);
    expect(subscribe).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('throws when the response carries no image url', async () => {
    const { client } = fakeFal({ images: [] });
    stubDownload();
    await expect(
      generateImage({ model: FLUX, prompt: 'p', outPath: path.join(tmpDir(), 'x.png'), client }),
    ).rejects.toThrow(/no image url/);
  });

  it('throws when the asset download fails', async () => {
    const { client } = fakeFal({ images: [{ url: 'https://fal.cdn/img.png' }] });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 403 }));
    await expect(
      generateImage({ model: FLUX, prompt: 'p', outPath: path.join(tmpDir(), 'x.png'), client }),
    ).rejects.toThrow(/403/);
  });

  it('carries the table cost when the download fails after a paid subscribe', async () => {
    // subscribe succeeded (billed) but the download 500s; the thrown error must
    // carry the deterministic table cost so the stage can ledger the paid attempt.
    const { client } = fakeFal({ images: [{ url: 'https://fal.cdn/img.png' }] });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500 }));
    const err = await generateImage({ model: FLUX, prompt: 'p', outPath: path.join(tmpDir(), 'x.png'), client }).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderCostError);
    expect((err as ProviderCostError).costUsdMicros).toBe(50_000);
    expect((err as Error).message).toMatch(/500/);
  });

  it('fails fast when FAL_KEY is missing and no client is injected', async () => {
    vi.stubEnv('FAL_KEY', undefined);
    const fetchMock = stubDownload();
    await expect(
      generateImage({ model: FLUX, prompt: 'p', outPath: path.join(tmpDir(), 'x.png') }),
    ).rejects.toThrow(/FAL_KEY/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('animateImage', () => {
  async function writeKeyframe(): Promise<string> {
    const p = path.join(tmpDir(), 'scene-01.png');
    await writeFile(p, Buffer.from([1, 2, 3]));
    return p;
  }

  it('uploads the keyframe and sends Kling input with audio off', async () => {
    const { client, subscribe, upload } = fakeFal({ video: { url: 'https://fal.cdn/clip.mp4' } });
    const fetchMock = stubDownload();
    const imagePath = await writeKeyframe();
    const outPath = path.join(tmpDir(), 'scene-01.mp4');

    const result = await animateImage({ model: KLING, imagePath, motionPrompt: 'slow dolly in', durationSec: 10, outPath, client });

    expect(upload).toHaveBeenCalledTimes(1);
    const uploaded = upload.mock.calls[0][0];
    expect(uploaded).toBeInstanceOf(Blob);
    expect(uploaded.type).toBe('image/png');
    expect(subscribe).toHaveBeenCalledWith(KLING, {
      input: {
        prompt: 'slow dolly in',
        start_image_url: 'https://fal.storage/uploaded-keyframe.png',
        duration: '10',
        generate_audio: false,
      },
    });
    expect(fetchMock).toHaveBeenCalledWith('https://fal.cdn/clip.mp4');
    expect(readFileSync(outPath)).toEqual(Buffer.from(FILE_BYTES));
    expect(result.costUsdMicros).toBe(840_000);
  });

  it('maps a 5s request to MiniMax 6s input at 512P', async () => {
    const { client, subscribe } = fakeFal({ video: { url: 'https://fal.cdn/clip.mp4' } });
    stubDownload();
    const imagePath = await writeKeyframe();
    const outPath = path.join(tmpDir(), 'scene-01.mp4');

    const result = await animateImage({ model: MINIMAX, imagePath, motionPrompt: 'gentle zoom', durationSec: 5, outPath, client });

    expect(subscribe).toHaveBeenCalledWith(MINIMAX, {
      input: {
        prompt: 'gentle zoom',
        image_url: 'https://fal.storage/uploaded-keyframe.png',
        duration: '6',
        resolution: '512P',
        prompt_optimizer: false,
      },
    });
    expect(result.costUsdMicros).toBe(102_000);
  });

  it('rejects an unpriced model before upload or subscribe', async () => {
    const { client, subscribe, upload } = fakeFal({ video: { url: 'https://fal.cdn/clip.mp4' } });
    stubDownload();
    const imagePath = await writeKeyframe();
    await expect(
      animateImage({ model: 'fal-ai/unknown-video', imagePath, motionPrompt: 'm', durationSec: 5, outPath: path.join(tmpDir(), 'x.mp4'), client }),
    ).rejects.toThrow(/no price table entry/);
    expect(upload).not.toHaveBeenCalled();
    expect(subscribe).not.toHaveBeenCalled();
  });

  it('throws when the response carries no video url', async () => {
    const { client } = fakeFal({});
    stubDownload();
    const imagePath = await writeKeyframe();
    await expect(
      animateImage({ model: KLING, imagePath, motionPrompt: 'm', durationSec: 5, outPath: path.join(tmpDir(), 'x.mp4'), client }),
    ).rejects.toThrow(/no video url/);
  });
});
