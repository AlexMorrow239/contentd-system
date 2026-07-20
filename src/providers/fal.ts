import { readFile, writeFile } from 'node:fs/promises';
import { fal } from '@fal-ai/client';

export type FalPrice =
  | { kind: 'per-image'; usdMicros: number }
  | { kind: 'per-second'; usdMicrosPerSecond: number }
  | { kind: 'per-video'; usdMicros: number };

// List prices verified against fal.ai model pages on 2026-07-19. fal responses
// carry no billing data, so the ledger records these list prices.
export const FAL_PRICE_TABLE: Record<string, FalPrice> = {
  // $0.025/megapixel, billed by rounding UP to the nearest megapixel
  // (fal.ai/models/fal-ai/flux/dev, checked 2026-07-19). The adapter requests
  // the portrait_16_9 preset (768x1344 ~= 1.03 MP), which bills as 2 MP in the
  // worst case -> $0.05/image. Ledger at the worst-case rounding so recorded
  // cost never understates real spend.
  'fal-ai/flux/dev': { kind: 'per-image', usdMicros: 50_000 },
  // $0.084/second with generate_audio=false — audio-on bills $0.126/s and our
  // clips are muted in assembly anyway (fal.ai/models/fal-ai/kling-video/v3/
  // standard/image-to-video, checked 2026-07-19).
  'fal-ai/kling-video/v3/standard/image-to-video': { kind: 'per-second', usdMicrosPerSecond: 84_000 },
  // ~$0.017/second at the 512P resolution this adapter pins for the endpoint
  // (768P bills $0.045/s; fal.ai/models/fal-ai/minimax/hailuo-02/standard/
  // image-to-video, checked 2026-07-19). Designated cheap-run + contract-test
  // model — the premium default is Kling above.
  'fal-ai/minimax/hailuo-02/standard/image-to-video': { kind: 'per-second', usdMicrosPerSecond: 17_000 },
};

export function estimateImageCostMicros(model: string): number {
  const price = FAL_PRICE_TABLE[model];
  if (!price) throw new Error(`fal: no price table entry for model "${model}"`);
  if (price.kind !== 'per-image') throw new Error(`fal: model "${model}" is not priced per-image`);
  return price.usdMicros;
}

export function estimateVideoCostMicros(model: string, durationSec: number): number {
  const price = FAL_PRICE_TABLE[model];
  if (!price) throw new Error(`fal: no price table entry for model "${model}"`);
  if (price.kind === 'per-second') return price.usdMicrosPerSecond * billedVideoSeconds(model, durationSec);
  if (price.kind === 'per-video') return price.usdMicros;
  throw new Error(`fal: model "${model}" is not priced per-second or per-video`);
}

export interface FalClientLike {
  subscribe(model: string, opts: { input: Record<string, unknown> }): Promise<{ data: Record<string, unknown> }>;
  storage: { upload(file: Blob): Promise<string> };
}

function defaultClient(): FalClientLike {
  // @fal-ai/client reads FAL_KEY from the environment on its own; this check
  // only turns a missing key into an immediate, clearly-named failure instead
  // of a late HTTP 401 from the queue API.
  if (!process.env.FAL_KEY) throw new Error('fal: FAL_KEY is not set (inject a client or add it to .env)');
  return fal as unknown as FalClientLike;
}

async function download(url: string, outPath: string): Promise<void> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fal: asset download failed with ${res.status} for ${url}`);
  await writeFile(outPath, Buffer.from(await res.arrayBuffer()));
}

export async function generateImage(opts: {
  model: string;
  prompt: string;
  outPath: string;
  client?: FalClientLike; // injected in tests; defaults to the real fal singleton
}): Promise<{ costUsdMicros: number }> {
  // Price BEFORE the paid call: an unpriced model must fail at zero spend.
  const costUsdMicros = estimateImageCostMicros(opts.model);
  const client = opts.client ?? defaultClient();
  // FLUX-family input shape. 9:16 is hard-coded here: portrait_16_9 (768x1344).
  // png output matches the visuals/scene-NN.png artifact convention.
  const { data } = await client.subscribe(opts.model, {
    input: { prompt: opts.prompt, image_size: 'portrait_16_9', num_images: 1, output_format: 'png' },
  });
  const images = data.images as Array<{ url?: string }> | undefined;
  const url = images?.[0]?.url;
  if (!url) throw new Error(`fal: no image url in response from ${opts.model}`);
  await download(url, opts.outPath);
  return { costUsdMicros };
}

export async function animateImage(opts: {
  model: string;
  imagePath: string;
  motionPrompt: string;
  durationSec: 5 | 10;
  outPath: string;
  client?: FalClientLike; // injected in tests; defaults to the real fal singleton
}): Promise<{ costUsdMicros: number }> {
  // Price BEFORE the paid call: an unpriced model must fail at zero spend.
  const costUsdMicros = estimateVideoCostMicros(opts.model, opts.durationSec);
  const client = opts.client ?? defaultClient();
  const bytes = await readFile(opts.imagePath);
  // Keyframes are always png (visuals/scene-NN.png artifact convention).
  const imageUrl = await client.storage.upload(new Blob([bytes], { type: 'image/png' }));
  const { data } = await client.subscribe(opts.model, {
    input: videoInput(opts.model, imageUrl, opts.motionPrompt, opts.durationSec),
  });
  const video = data.video as { url?: string } | undefined;
  if (!video?.url) throw new Error(`fal: no video url in response from ${opts.model}`);
  await download(video.url, opts.outPath);
  return { costUsdMicros };
}

// Per-endpoint input naming (schemas verified 2026-07-19 via each endpoint's
// queue OpenAPI). Both endpoints derive the clip's aspect ratio from the input
// image, so 9:16 comes from the 9:16 keyframe — no aspect field exists.
function videoInput(model: string, imageUrl: string, motionPrompt: string, durationSec: 5 | 10): Record<string, unknown> {
  if (model.startsWith('fal-ai/kling-video/')) {
    // Kling v3 i2v: duration is a string "3".."15"; audio off — narration owns
    // the audio track, and audio-on bills 50% more per second.
    return { prompt: motionPrompt, start_image_url: imageUrl, duration: String(durationSec), generate_audio: false };
  }
  if (model.startsWith('fal-ai/minimax/')) {
    // Hailuo-02 i2v: duration only allows "6" | "10" — a 5s request maps up to
    // 6s (billedVideoSeconds applies the same mapping so the ledger matches).
    // 512P pinned: this is the cheap-run model. prompt_optimizer off: motion
    // prompts are authored by the script stage; keep them verbatim.
    return {
      prompt: motionPrompt,
      image_url: imageUrl,
      duration: durationSec === 5 ? '6' : '10',
      resolution: '512P',
      prompt_optimizer: false,
    };
  }
  throw new Error(`fal: no input builder for model "${model}"`);
}

function billedVideoSeconds(model: string, durationSec: number): number {
  // Hailuo-02 only renders 6s or 10s; a 5s request renders (and bills) 6s.
  if (model.startsWith('fal-ai/minimax/') && durationSec === 5) return 6;
  return durationSec;
}
