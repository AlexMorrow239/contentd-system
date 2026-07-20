import { describe, it, expect, vi, beforeEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { Readable } from 'node:stream';

vi.mock('kokoro-js', () => ({ KokoroTTS: { from_pretrained: vi.fn() } }));
vi.mock('msedge-tts', () => ({ MsEdgeTTS: vi.fn(), OUTPUT_FORMAT: {} }));

import { KokoroTTS } from 'kokoro-js';
import { MsEdgeTTS } from 'msedge-tts';
import { voiceStage, MAX_CHUNK_WORDS } from './voice.js';
import { countWords } from './narration-text.js';
import { parseWavDurationMs } from '../media/wav.js';
import { makeCtx, testScript } from './_testkit.js';
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

const SCRIPT = testScript();

// A 19-word sentence; repeat it to build narration of a known length.
const SENTENCE =
  'Venus spins backwards compared to every other planet orbiting our star and nobody really knows exactly why that happens.';
const SENTENCE_WORDS = 19;

// 15 sentences -> 285 narration words, far past kokoro's ~80-word context window.
const LONG_SCRIPT = testScript({ hook: SENTENCE, segments: Array.from({ length: 14 }, () => SENTENCE) });
const LONG_SCRIPT_WORDS = 15 * SENTENCE_WORDS;

const KOKORO_RATE = 24000;

// Mock kokoro output: RawAudio-shaped { audio, sampling_rate }, 2 words/sec of
// samples so synthesized length is plausible for the text it was given.
function chunkAudio(text: string): { audio: Float32Array; sampling_rate: number } {
  return {
    audio: new Float32Array(countWords(text) * (KOKORO_RATE / 2)),
    sampling_rate: KOKORO_RATE,
  };
}

async function ctxWithScript(script: unknown = SCRIPT): Promise<JobContext> {
  const ctx = makeCtx();
  await fs.writeFile(ctx.artifactPath('script', 'script.json'), JSON.stringify(script));
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
    const generate = vi.fn(async (t: string) => chunkAudio(t));
    vi.mocked(KokoroTTS.from_pretrained).mockResolvedValue({ generate } as never);

    await voiceStage.run(ctx);

    // 4 words fits in one chunk, so the text still reaches kokoro in one call.
    expect(generate).toHaveBeenCalledTimes(1);
    // Chunk packing rejoins sentence pieces with single spaces.
    expect(generate).toHaveBeenCalledWith('Hook here\n\nOne. Two.', { voice: 'af_heart' });
    const meta = JSON.parse(await fs.readFile(ctx.artifactPath('voice', 'voice.json'), 'utf8'));
    expect(meta).toEqual({ provider: 'kokoro', voiceId: 'af_heart', durationMs: 2000 });
  });

  it('splits long narration into multiple under-budget kokoro calls and concatenates them', async () => {
    const ctx = await ctxWithScript(LONG_SCRIPT);
    const generate = vi.fn(async (t: string) => chunkAudio(t));
    vi.mocked(KokoroTTS.from_pretrained).mockResolvedValue({ generate } as never);

    await voiceStage.run(ctx);

    const texts = generate.mock.calls.map((c) => c[0] as string);
    expect(texts.length).toBeGreaterThan(1);
    for (const t of texts) expect(countWords(t)).toBeLessThanOrEqual(MAX_CHUNK_WORDS);
    // Nothing may be dropped: every narration word must appear in some chunk.
    expect(texts.reduce((n, t) => n + countWords(t), 0)).toBe(LONG_SCRIPT_WORDS);

    // Concatenated wav duration == sum of the per-chunk durations.
    const expectedMs = texts.reduce((ms, t) => ms + countWords(t) * 500, 0);
    const wav = await fs.readFile(ctx.artifactPath('voice', 'narration.wav'));
    expect(parseWavDurationMs(wav)).toBe(expectedMs);
    const meta = JSON.parse(await fs.readFile(ctx.artifactPath('voice', 'voice.json'), 'utf8'));
    expect(meta.durationMs).toBe(expectedMs);
  });

  it('throws when synthesized audio is implausibly short for the script (truncation guard)', async () => {
    const ctx = await ctxWithScript(LONG_SCRIPT);
    // Simulate silent truncation: every chunk comes back as 100ms of audio.
    const generate = vi.fn().mockResolvedValue({
      audio: new Float32Array(KOKORO_RATE / 10),
      sampling_rate: KOKORO_RATE,
    });
    vi.mocked(KokoroTTS.from_pretrained).mockResolvedValue({ generate } as never);

    await expect(voiceStage.run(ctx)).rejects.toThrow(/truncat/i);
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

  it('chunks and concatenates on the edge-tts path too', async () => {
    const ctx = await ctxWithScript(LONG_SCRIPT);
    vi.mocked(KokoroTTS.from_pretrained).mockRejectedValue(new Error('no model'));
    const setMetadata = vi.fn().mockResolvedValue(undefined);
    // Each edge response is its own RIFF stream: 12s per chunk keeps the total
    // above the truncation guard's plausibility floor.
    const toStream = vi.fn((t: string) => ({ text: t, audioStream: Readable.from([buildWav(16000 * 12)]) }));
    vi.mocked(MsEdgeTTS).mockImplementation(function () { return { setMetadata, toStream }; } as never);

    await voiceStage.run(ctx);

    const texts = toStream.mock.calls.map((c) => c[0]);
    expect(texts.length).toBeGreaterThan(1);
    for (const t of texts) expect(countWords(t)).toBeLessThanOrEqual(MAX_CHUNK_WORDS);
    // PCM payloads concatenate into one valid wav of the summed duration.
    const wav = await fs.readFile(ctx.artifactPath('voice', 'narration.wav'));
    expect(parseWavDurationMs(wav)).toBe(texts.length * 12000);
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
