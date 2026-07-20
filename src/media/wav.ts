// RIFF/WAVE container primitives. Kept here rather than in the voice stage so a
// stage that needs to read or build a WAV does not import a sibling stage.

const BITS_PER_SAMPLE = 16;
const BYTES_PER_SAMPLE = BITS_PER_SAMPLE / 8;

export interface ParsedWav {
  sampleRate: number;
  channels: number;
  byteRate: number;
  data: Buffer;
}

// Wrap raw 16-bit PCM payloads in a canonical RIFF/WAVE container with correct
// sizes. Takes the parts unjoined so the payload is copied once, into the output.
export function encodePcmWav(parts: Buffer[], sampleRate: number, channels: number): Buffer {
  const dataLength = parts.reduce((n, p) => n + p.length, 0);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + dataLength, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16); // PCM fmt chunk size
  header.writeUInt16LE(1, 20); // audioFormat: PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * channels * BYTES_PER_SAMPLE, 28); // byteRate
  header.writeUInt16LE(channels * BYTES_PER_SAMPLE, 32); // blockAlign
  header.writeUInt16LE(BITS_PER_SAMPLE, 34);
  header.write('data', 36);
  header.writeUInt32LE(dataLength, 40);
  return Buffer.concat([header, ...parts], 44 + dataLength);
}

// Quantize Float32 samples (kokoro's RawAudio payload) to a 16-bit PCM payload.
export function pcmFromFloat32(samples: Float32Array): Buffer {
  const data = Buffer.alloc(samples.length * BYTES_PER_SAMPLE);
  const view = new Int16Array(data.buffer, data.byteOffset, samples.length);
  for (let i = 0; i < samples.length; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    view[i] = Math.round(clamped * 32767);
  }
  return data;
}

// Walk a RIFF/WAVE buffer for its fmt parameters and raw PCM payload.
export function parseWav(buf: Buffer): ParsedWav {
  if (buf.length < 12 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('parseWav: not a RIFF/WAVE buffer');
  }
  let sampleRate = 0;
  let channels = 0;
  let byteRate = 0;
  let data: Buffer | undefined;
  let offset = 12;
  while (offset + 8 <= buf.length) {
    const chunkId = buf.toString('ascii', offset, offset + 4);
    const chunkSize = buf.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (chunkId === 'fmt ') {
      // fmt: audioFormat(2) channels(2) sampleRate(4) byteRate(4)
      channels = buf.readUInt16LE(body + 2);
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
  if (byteRate <= 0 || !data) throw new Error('parseWav: missing fmt or data chunk');
  return { sampleRate, channels, byteRate, data };
}

// Duration from a RIFF/WAVE header: data-chunk size / fmt byteRate.
export function parseWavDurationMs(buf: Buffer): number {
  const { byteRate, data } = parseWav(buf);
  return Math.floor((data.length / byteRate) * 1000);
}
