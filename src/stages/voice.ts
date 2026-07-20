import { promises as fs } from 'node:fs';
import { KokoroTTS, type GenerateOptions } from 'kokoro-js';
import { MsEdgeTTS, type OUTPUT_FORMAT } from 'msedge-tts';
import type { StageDef, JobContext } from '../jobs/types.js';
import type { ScriptOutput } from './script.js';
import { narrationText, countWords, minPlausibleNarrationMs, MAX_PLAUSIBLE_WORDS_PER_SEC } from './narration-text.js';
import { encodePcmWav, pcmFromFloat32, parseWav, parseWavDurationMs, trimTrailingSilence } from '../media/wav.js';

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

// Break any piece still over budget on `boundary`; leave the rest alone.
function refine(pieces: string[], boundary: RegExp): string[] {
  return pieces.flatMap((piece) =>
    countWords(piece) <= MAX_CHUNK_WORDS
      ? [piece]
      : piece
          .split(boundary)
          .map((s) => s.trim())
          .filter(Boolean),
  );
}

// Split `text` into pieces of at most MAX_CHUNK_WORDS words, preferring the most
// natural boundary available: sentences, then clauses, then a hard word count.
export function splitForTts(text: string): string[] {
  const sentences = text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const clauses = refine(sentences, /(?<=,)\s+/);
  // Anything still over budget has no punctuation to lean on: slice on raw word
  // count so no piece can ever exceed what the model will accept.
  const atomic = clauses.flatMap((piece) => {
    const words = piece.split(/\s+/).filter(Boolean);
    if (words.length <= MAX_CHUNK_WORDS) return [piece];
    const sliced: string[] = [];
    for (let i = 0; i < words.length; i += MAX_CHUNK_WORDS) {
      sliced.push(words.slice(i, i + MAX_CHUNK_WORDS).join(' '));
    }
    return sliced;
  });

  // Greedily pack the atomic pieces back into full-budget chunks.
  const chunks: string[] = [];
  let current = '';
  let currentWords = 0;
  for (const piece of atomic) {
    const pieceWords = countWords(piece);
    if (current && currentWords + pieceWords > MAX_CHUNK_WORDS) {
      chunks.push(current);
      current = piece;
      currentWords = pieceWords;
    } else {
      current = current ? `${current} ${piece}` : piece;
      currentWords += pieceWords;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

// One synthesized chunk, reduced to the PCM payload plus the format it came in.
interface PcmChunk {
  data: Buffer;
  sampleRate: number;
  channels: number;
}

/**
 * Synthesize `text` one under-budget chunk at a time and write the concatenated
 * PCM as a single WAV. Chunks are synthesized sequentially on purpose: kokoro is
 * local ONNX inference against one model instance and edge-tts reuses one socket,
 * so concurrency would only contend.
 *
 * Each chunk's trailing silence is capped before concatenation: kokoro pads
 * every generation with multi-second silence, which would otherwise embed dead
 * air between chunks and a long silent tail after the last word (Plan 1 real
 * tail run: 15375ms narration whose aligned words end ~10490ms — captions stop
 * while the video keeps running).
 */
async function synthChunked(
  text: string,
  provider: string,
  synth: (chunk: string) => Promise<PcmChunk>,
  wavPath: string,
): Promise<void> {
  const parts: Buffer[] = [];
  let sampleRate = 0;
  let channels = 0;
  for (const chunk of splitForTts(text)) {
    const pcm = await synth(chunk);
    parts.push(trimTrailingSilence(pcm.data, pcm.sampleRate, Math.max(1, pcm.channels)));
    sampleRate = pcm.sampleRate;
    channels = pcm.channels;
  }
  if (parts.length === 0 || sampleRate <= 0) throw new Error(`${provider} produced no audio`);
  await fs.writeFile(wavPath, encodePcmWav(parts, sampleRate, Math.max(1, channels)));
}

async function synthKokoro(text: string, voiceId: string, wavPath: string): Promise<void> {
  const tts = await KokoroTTS.from_pretrained(KOKORO_MODEL_ID, { dtype: 'q8' });
  await synthChunked(
    text,
    'kokoro',
    async (chunk) => {
      // ctx.channel.voice.volume is a runtime-configured string; kokoro-js types the
      // `voice` option as a narrow union of built-in voice names. Narrow the config
      // value here, mirroring the EDGE_FORMAT cast above.
      const audio = await tts.generate(chunk, { voice: voiceId as GenerateOptions['voice'] });
      return { data: pcmFromFloat32(audio.audio), sampleRate: audio.sampling_rate, channels: 1 };
    },
    wavPath,
  );
}

async function synthEdge(text: string, wavPath: string): Promise<void> {
  const tts = new MsEdgeTTS();
  await tts.setMetadata(EDGE_VOICE, EDGE_FORMAT);

  // Edge TTS is a cloud service with no local context window, but its input limits
  // are undocumented and could not be exercised here (the endpoint currently answers
  // 403), so the same chunking is applied defensively. It is safe either way: each
  // response is a self-contained RIFF stream whose PCM payloads concatenate cleanly.
  await synthChunked(
    text,
    'edge-tts',
    async (chunk) => {
      // toStream is synchronous in current msedge-tts; awaiting a plain object is a
      // no-op, so this is robust across versions that return a promise.
      const { audioStream } = await tts.toStream(chunk);
      const buffers: Buffer[] = [];
      for await (const b of audioStream as AsyncIterable<Uint8Array>) buffers.push(Buffer.from(b));
      const wav = parseWav(Buffer.concat(buffers));
      return { data: wav.data, sampleRate: wav.sampleRate, channels: wav.channels };
    },
    wavPath,
  );
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
    const minPlausibleMs = minPlausibleNarrationMs(words);
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
