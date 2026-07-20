import 'dotenv/config';
import { describe, it, expect } from 'vitest';
import { parseWav } from '../media/wav.js';
import { estimateTtsCostMicros, synthWithTimestamps } from './elevenlabs.js';

// Runs only via `pnpm test:contract` (excluded from default `pnpm test`).
// Makes ONE real ElevenLabs synthesis (39 chars ≈ $0.012 at the Creator overage
// rate); needs ELEVENLABS_API_KEY (shell env or .env — loaded here because
// vitest does not read .env on its own).
describe('synthWithTimestamps (contract)', () => {
  it('synthesizes a short phrase into parseable 24kHz WAV with monotonic word timings', async () => {
    const text = 'The quick brown fox jumps over the dog.'; // 39 chars, 8 words
    expect(estimateTtsCostMicros(text)).toBeLessThan(20_000); // hard guard: < $0.02

    const { wavBytes, durationMs, words, costUsdMicros } = await synthWithTimestamps({
      voiceId: 'EXAVITQu4vr4xnSDxMaL', // Sarah — public premade voice; same id channels/example.toml uses (Task 5)
      modelId: 'eleven_multilingual_v2',
      text,
    });

    const wav = parseWav(wavBytes);
    expect(wav.sampleRate).toBe(24_000);
    expect(wav.channels).toBe(1);
    expect(durationMs).toBeGreaterThan(1_000); // 8 spoken words cannot fit in under a second

    // Word grouping over real alignment data: near-complete (tolerate one
    // provider-side merge), monotonic, non-overlapping, inside the audio span.
    expect(words.length).toBeGreaterThanOrEqual(7);
    for (let i = 0; i < words.length; i++) {
      expect(words[i].startMs).toBeLessThanOrEqual(words[i].endMs);
      if (i > 0) expect(words[i].startMs).toBeGreaterThanOrEqual(words[i - 1].endMs);
    }
    expect(words[words.length - 1].endMs).toBeLessThanOrEqual(durationMs + 100);
    expect(costUsdMicros).toBe(estimateTtsCostMicros(text));
  }, 60_000);
});
