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

// Duration from a RIFF/WAVE header: data-chunk size / fmt byteRate.
export function parseWavDurationMs(buf: Buffer): number {
  if (buf.length < 12 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('parseWavDurationMs: not a RIFF/WAVE buffer');
  }
  let byteRate = 0;
  let dataSize = 0;
  let dataFound = false;
  let offset = 12;
  while (offset + 8 <= buf.length) {
    const chunkId = buf.toString('ascii', offset, offset + 4);
    const chunkSize = buf.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (chunkId === 'fmt ') {
      byteRate = buf.readUInt32LE(body + 8); // fmt: audioFormat(2) channels(2) sampleRate(4) byteRate(4)
    } else if (chunkId === 'data') {
      // Streaming WAVs (edge-tts) may declare a placeholder size larger than the
      // actual payload; clamp to the bytes we really have.
      dataSize = Math.min(chunkSize, buf.length - body);
      dataFound = true;
      break;
    }
    offset = body + chunkSize + (chunkSize & 1); // chunks are word-aligned
  }
  if (byteRate <= 0 || !dataFound) throw new Error('parseWavDurationMs: missing fmt or data chunk');
  return Math.floor((dataSize / byteRate) * 1000);
}

async function synthKokoro(text: string, voiceId: string, wavPath: string): Promise<void> {
  const tts = await KokoroTTS.from_pretrained(KOKORO_MODEL_ID, { dtype: 'q8' });
  // ctx.channel.voice.volume is a runtime-configured string; kokoro-js types the
  // `voice` option as a narrow union of built-in voice names. Narrow the config
  // value here, mirroring the EDGE_FORMAT cast above.
  const audio = await tts.generate(text, { voice: voiceId as GenerateOptions['voice'] });
  await audio.save(wavPath);
}

async function synthEdge(text: string, wavPath: string): Promise<void> {
  const tts = new MsEdgeTTS();
  await tts.setMetadata(EDGE_VOICE, EDGE_FORMAT);
  // toStream is synchronous in current msedge-tts; awaiting a plain object is a
  // no-op, so this is robust across versions that return a promise.
  const { audioStream } = await tts.toStream(text);
  const chunks: Buffer[] = [];
  for await (const chunk of audioStream as AsyncIterable<Uint8Array>) chunks.push(Buffer.from(chunk));
  await fs.writeFile(wavPath, Buffer.concat(chunks));
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
    const meta: VoiceMeta = { provider, voiceId, durationMs };
    await fs.writeFile(ctx.artifactPath('voice', 'voice.json'), JSON.stringify(meta, null, 2));
  },
};
