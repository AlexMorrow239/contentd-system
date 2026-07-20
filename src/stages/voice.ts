import { promises as fs } from 'node:fs';
import { KokoroTTS, type GenerateOptions } from 'kokoro-js';
import { MsEdgeTTS, type OUTPUT_FORMAT } from 'msedge-tts';
import type { StageDef, JobContext } from '../jobs/types.js';
import type { ScriptOutput } from './script.js';
import { narrationText } from './narration-text.js';

export interface VoiceMeta {
  provider: 'kokoro' | 'edge-tts';
  voiceId: string;
  durationMs: number;
}

const KOKORO_MODEL_ID = 'onnx-community/Kokoro-82M-v1.0-ONNX';
const EDGE_VOICE = 'en-US-AriaNeural';
// The Edge TTS backend supports "riff-24khz-16bit-mono-pcm" (a RIFF/WAV PCM
// container), but msedge-tts ships that OUTPUT_FORMAT member commented out, so
// only MP3/Opus constants exist. We pass the literal, protocol-valid format
// string; the cast only satisfies the enum-typed parameter.
const EDGE_FORMAT = 'riff-24khz-16bit-mono-pcm' as unknown as OUTPUT_FORMAT;

// kokoro-js tokenizes with `truncation: true` against the model's 510-phoneme-token
// context (see `generate_from_ids`: `Math.min(..., 509)`). Anything past that is
// silently dropped, yielding a well-formed WAV holding only the start of the script.
// ~510 phoneme tokens is roughly 80 English words; 60 is a conservative budget that
// leaves headroom for phoneme-dense words.
export const MAX_CHUNK_WORDS = 60;

// Natural narration runs 2.5-3 words/sec. 5 w/s is a generous ceiling that no real
// synthesis exceeds, so falling under it means audio was lost.
export const MAX_PLAUSIBLE_WORDS_PER_SEC = 5;

function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

// Split `text` into pieces of at most MAX_CHUNK_WORDS words, preferring the most
// natural boundary available: sentences, then clauses, then a hard word count.
export function splitForTts(text: string): string[] {
  const sentences = text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  const atomic: string[] = [];
  for (const sentence of sentences) {
    if (countWords(sentence) <= MAX_CHUNK_WORDS) {
      atomic.push(sentence);
      continue;
    }
    // Too long to speak in one pass: fall back to clause boundaries.
    for (const clause of sentence.split(/(?<=,)\s+/)) {
      const c = clause.trim();
      if (!c) continue;
      if (countWords(c) <= MAX_CHUNK_WORDS) {
        atomic.push(c);
        continue;
      }
      // Still too long (no punctuation to lean on): split on raw word count so no
      // piece can ever exceed the budget.
      const words = c.split(/\s+/).filter(Boolean);
      for (let i = 0; i < words.length; i += MAX_CHUNK_WORDS) {
        atomic.push(words.slice(i, i + MAX_CHUNK_WORDS).join(' '));
      }
    }
  }

  // Greedily pack the atomic pieces back into full-budget chunks.
  const chunks: string[] = [];
  let current = '';
  for (const piece of atomic) {
    const merged = current ? `${current} ${piece}` : piece;
    if (current && countWords(merged) > MAX_CHUNK_WORDS) {
      chunks.push(current);
      current = piece;
    } else {
      current = merged;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

const BITS_PER_SAMPLE = 16;
const BYTES_PER_SAMPLE = BITS_PER_SAMPLE / 8;

// Wrap raw 16-bit PCM in a canonical RIFF/WAVE container with correct sizes.
function encodePcmWav(data: Buffer, sampleRate: number, byteRate: number): Buffer {
  const channels = Math.max(1, Math.round(byteRate / (sampleRate * BYTES_PER_SAMPLE)));
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16); // PCM fmt chunk size
  header.writeUInt16LE(1, 20); // audioFormat: PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(channels * BYTES_PER_SAMPLE, 32); // blockAlign
  header.writeUInt16LE(BITS_PER_SAMPLE, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

// Encode mono Float32 samples (kokoro's RawAudio payload) as a 16-bit PCM WAV.
function encodeWav(samples: Float32Array, sampleRate: number): Buffer {
  const data = Buffer.alloc(samples.length * BYTES_PER_SAMPLE);
  for (let i = 0; i < samples.length; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    data.writeInt16LE(Math.round(clamped * 32767), i * BYTES_PER_SAMPLE);
  }
  return encodePcmWav(data, sampleRate, sampleRate * BYTES_PER_SAMPLE);
}

interface ParsedWav {
  sampleRate: number;
  byteRate: number;
  data: Buffer;
}

// Walk a RIFF/WAVE buffer for its fmt parameters and raw PCM payload.
function parseWav(buf: Buffer): ParsedWav {
  if (buf.length < 12 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('parseWavDurationMs: not a RIFF/WAVE buffer');
  }
  let sampleRate = 0;
  let byteRate = 0;
  let data: Buffer | undefined;
  let offset = 12;
  while (offset + 8 <= buf.length) {
    const chunkId = buf.toString('ascii', offset, offset + 4);
    const chunkSize = buf.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (chunkId === 'fmt ') {
      // fmt: audioFormat(2) channels(2) sampleRate(4) byteRate(4)
      sampleRate = buf.readUInt32LE(body + 4);
      byteRate = buf.readUInt32LE(body + 8);
    } else if (chunkId === 'data') {
      // Streaming WAVs (edge-tts) may declare a placeholder size larger than the
      // actual payload; clamp to the bytes we really have.
      data = buf.subarray(body, body + Math.min(chunkSize, buf.length - body));
      break;
    }
    offset = body + chunkSize + (chunkSize & 1); // chunks are word-aligned
  }
  if (byteRate <= 0 || !data) throw new Error('parseWavDurationMs: missing fmt or data chunk');
  return { sampleRate, byteRate, data };
}

// Duration from a RIFF/WAVE header: data-chunk size / fmt byteRate.
export function parseWavDurationMs(buf: Buffer): number {
  const { byteRate, data } = parseWav(buf);
  return Math.floor((data.length / byteRate) * 1000);
}

async function synthKokoro(text: string, voiceId: string, wavPath: string): Promise<void> {
  const tts = await KokoroTTS.from_pretrained(KOKORO_MODEL_ID, { dtype: 'q8' });
  const chunks = splitForTts(text);
  const parts: Float32Array[] = [];
  let sampleRate = 0;
  for (const chunk of chunks) {
    // ctx.channel.voice.volume is a runtime-configured string; kokoro-js types the
    // `voice` option as a narrow union of built-in voice names. Narrow the config
    // value here, mirroring the EDGE_FORMAT cast above.
    const audio = await tts.generate(chunk, { voice: voiceId as GenerateOptions['voice'] });
    parts.push(audio.audio);
    sampleRate = audio.sampling_rate;
  }
  if (parts.length === 0 || sampleRate <= 0) throw new Error('kokoro produced no audio');

  const total = parts.reduce((n, p) => n + p.length, 0);
  const combined = new Float32Array(total);
  let offset = 0;
  for (const p of parts) {
    combined.set(p, offset);
    offset += p.length;
  }
  await fs.writeFile(wavPath, encodeWav(combined, sampleRate));
}

async function synthEdge(text: string, wavPath: string): Promise<void> {
  const tts = new MsEdgeTTS();
  await tts.setMetadata(EDGE_VOICE, EDGE_FORMAT);

  // Edge TTS is a cloud service with no local context window, but its input limits
  // are undocumented and could not be exercised here (the endpoint currently answers
  // 403), so the same chunking is applied defensively. It is safe either way: each
  // response is a self-contained RIFF stream whose PCM payloads concatenate cleanly.
  const parts: Buffer[] = [];
  let sampleRate = 0;
  let byteRate = 0;
  for (const chunk of splitForTts(text)) {
    // toStream is synchronous in current msedge-tts; awaiting a plain object is a
    // no-op, so this is robust across versions that return a promise.
    const { audioStream } = await tts.toStream(chunk);
    const buffers: Buffer[] = [];
    for await (const b of audioStream as AsyncIterable<Uint8Array>) buffers.push(Buffer.from(b));
    const wav = parseWav(Buffer.concat(buffers));
    parts.push(wav.data);
    sampleRate = wav.sampleRate;
    byteRate = wav.byteRate;
  }
  if (parts.length === 0 || byteRate <= 0) throw new Error('edge-tts produced no audio');

  await fs.writeFile(wavPath, encodePcmWav(Buffer.concat(parts), sampleRate, byteRate));
}

export const voiceStage: StageDef = {
  name: 'voice',
  async run(ctx: JobContext): Promise<void> {
    const script = JSON.parse(await fs.readFile(ctx.artifactPath('script', 'script.json'), 'utf8')) as ScriptOutput;
    const narration = narrationText(script);
    const wavPath = ctx.artifactPath('voice', 'narration.wav');

    let provider: VoiceMeta['provider'];
    let voiceId: string;
    try {
      await synthKokoro(narration, ctx.channel.voice.volume, wavPath);
      provider = 'kokoro';
      voiceId = ctx.channel.voice.volume;
    } catch (kokoroErr) {
      ctx.log.warn({ err: kokoroErr }, 'kokoro TTS failed; falling back to edge-tts');
      try {
        await synthEdge(narration, wavPath);
        provider = 'edge-tts';
        voiceId = EDGE_VOICE;
      } catch (edgeErr) {
        throw new Error(`voice synthesis failed: kokoro=${String(kokoroErr)}; edge=${String(edgeErr)}`);
      }
    }

    const durationMs = parseWavDurationMs(await fs.readFile(wavPath));

    // Defense in depth: a TTS backend that silently drops text still returns a
    // well-formed WAV, so the only signal is that it is too short for the script.
    const words = countWords(narration);
    const minPlausibleMs = Math.round(words * (1000 / MAX_PLAUSIBLE_WORDS_PER_SEC));
    if (durationMs < minPlausibleMs) {
      throw new Error(
        `voice synthesis produced implausibly short audio: ${durationMs}ms for ${words} words ` +
          `(minimum ${minPlausibleMs}ms at ${MAX_PLAUSIBLE_WORDS_PER_SEC} words/sec); ` +
          `narration was likely truncated by provider "${provider}"`,
      );
    }

    const meta: VoiceMeta = { provider, voiceId, durationMs };
    await fs.writeFile(ctx.artifactPath('voice', 'voice.json'), JSON.stringify(meta, null, 2));
  },
};
