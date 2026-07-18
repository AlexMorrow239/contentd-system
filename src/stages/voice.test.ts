import { describe, it, expect, vi, beforeEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { Readable } from 'node:stream';

vi.mock('kokoro-js', () => ({ KokoroTTS: { from_pretrained: vi.fn() } }));
vi.mock('msedge-tts', () => ({ MsEdgeTTS: vi.fn(), OUTPUT_FORMAT: {} }));

import { KokoroTTS } from 'kokoro-js';
import { MsEdgeTTS } from 'msedge-tts';
import { voiceStage, parseWavDurationMs } from './voice.js';
import { makeCtx } from './_testkit.js';
import type { JobContext } from '../jobs/types.js';

// Canonical mono 16-bit PCM WAV. byteRate = rate*channels*2.
function buildWav(numSamples: number, sampleRate = 16000): Buffer {
  const bytesPerSample = 2;
  const channels = 1;
  const byteRate = sampleRate * channels * bytesPerSample;
  const dataSize = numSamples * bytesPerSample;
  const buf = Buffer.alloc(44 + dataSize);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(channels, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(byteRate, 28);
  buf.writeUInt16LE(channels * bytesPerSample, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(dataSize, 40);
  return buf;
}

const ONE_SECOND_WAV = buildWav(16000); // 32000 data bytes / 32000 byteRate -> 1000 ms

const SCRIPT = {
  hook: 'Hook here',
  segments: [
    { text: 'One.', visualDirection: 'a' },
    { text: 'Two.', visualDirection: 'b' },
  ],
  platformMeta: {
    youtube: { title: 't', description: 'd', hashtags: [] },
    tiktok: { title: 't', description: 'd', hashtags: [] },
    instagram: { title: 't', description: 'd', hashtags: [] },
  },
};

async function ctxWithScript(): Promise<JobContext> {
  const ctx = makeCtx();
  await fs.writeFile(ctx.artifactPath('script', 'script.json'), JSON.stringify(SCRIPT));
  return ctx;
}

beforeEach(() => vi.clearAllMocks());

describe('parseWavDurationMs', () => {
  it('computes duration from data size / byteRate', () => {
    expect(parseWavDurationMs(buildWav(16000))).toBe(1000);
    expect(parseWavDurationMs(buildWav(8000))).toBe(500);
  });
  it('rejects non-RIFF buffers', () => {
    expect(() => parseWavDurationMs(Buffer.from('not a wav file at all'))).toThrow(/RIFF/);
  });
});

describe('voiceStage', () => {
  it('uses kokoro on the happy path and writes wav + meta', async () => {
    const ctx = await ctxWithScript();
    const save = vi.fn(async (p: string) => { await fs.writeFile(p, ONE_SECOND_WAV); });
    const generate = vi.fn().mockResolvedValue({ save });
    vi.mocked(KokoroTTS.from_pretrained).mockResolvedValue({ generate } as never);

    await voiceStage.run(ctx);

    expect(generate).toHaveBeenCalledWith('Hook here\n\nOne.\n\nTwo.', { voice: 'af_heart' });
    const meta = JSON.parse(await fs.readFile(ctx.artifactPath('voice', 'voice.json'), 'utf8'));
    expect(meta).toEqual({ provider: 'kokoro', voiceId: 'af_heart', durationMs: 1000 });
  });

  it('falls back to edge-tts when kokoro throws', async () => {
    const ctx = await ctxWithScript();
    vi.mocked(KokoroTTS.from_pretrained).mockRejectedValue(new Error('no model'));
    const setMetadata = vi.fn().mockResolvedValue(undefined);
    const toStream = vi.fn().mockReturnValue({ audioStream: Readable.from([ONE_SECOND_WAV]) });
    // vitest v4 constructs `new MsEdgeTTS()` via the mock implementation; an arrow
    // function is not a constructor, so use a regular function returning the stub.
    vi.mocked(MsEdgeTTS).mockImplementation(function () { return { setMetadata, toStream }; } as never);

    await voiceStage.run(ctx);

    const meta = JSON.parse(await fs.readFile(ctx.artifactPath('voice', 'voice.json'), 'utf8'));
    expect(meta).toEqual({ provider: 'edge-tts', voiceId: 'en-US-AriaNeural', durationMs: 1000 });
  });

  it('throws when both kokoro and edge-tts fail', async () => {
    const ctx = await ctxWithScript();
    vi.mocked(KokoroTTS.from_pretrained).mockRejectedValue(new Error('no model'));
    vi.mocked(MsEdgeTTS).mockImplementation(function () {
      return {
        setMetadata: vi.fn().mockResolvedValue(undefined),
        toStream: vi.fn(() => { throw new Error('edge down'); }),
      };
    } as never);

    await expect(voiceStage.run(ctx)).rejects.toThrow(/voice synthesis failed/);
  });
});
