import { describe, it, expect, vi, beforeEach } from 'vitest'
import { promises as fs } from 'node:fs'
import { Readable } from 'node:stream'

vi.mock('kokoro-js', () => ({ KokoroTTS: { from_pretrained: vi.fn() } }))
vi.mock('msedge-tts', () => ({ MsEdgeTTS: vi.fn(), OUTPUT_FORMAT: {} }))
vi.mock('../../providers/elevenlabs.js', () => ({
  estimateTtsCostMicros: vi.fn(() => 40_000),
  synthWithTimestamps: vi.fn(),
}))

import { KokoroTTS } from 'kokoro-js'
import { MsEdgeTTS } from 'msedge-tts'
import { voiceStage, MAX_CHUNK_WORDS, DEV_VOICE_ENV } from '../voice.js'
import { countWords, HOOK_PAUSE_MS } from '../narration-text.js'
import { parseWavDurationMs } from '../../media/wav.js'
import { testChannel } from '../../testing/channel.js'
import { makeCtx, testScript } from '../../testing/job.js'
import type { JobContext } from '../../jobs/types.js'
import { estimateTtsCostMicros, synthWithTimestamps } from '../../providers/elevenlabs.js'
import { BudgetExceededError } from '../../jobs/costs.js'

// Canonical mono 16-bit PCM WAV. byteRate = rate*channels*2.
function buildWav(numSamples: number, sampleRate = 16000): Buffer {
  const bytesPerSample = 2
  const channels = 1
  const byteRate = sampleRate * channels * bytesPerSample
  const dataSize = numSamples * bytesPerSample
  const buf = Buffer.alloc(44 + dataSize)
  buf.write('RIFF', 0)
  buf.writeUInt32LE(36 + dataSize, 4)
  buf.write('WAVE', 8)
  buf.write('fmt ', 12)
  buf.writeUInt32LE(16, 16)
  buf.writeUInt16LE(1, 20)
  buf.writeUInt16LE(channels, 22)
  buf.writeUInt32LE(sampleRate, 24)
  buf.writeUInt32LE(byteRate, 28)
  buf.writeUInt16LE(channels * bytesPerSample, 32)
  buf.writeUInt16LE(16, 34)
  buf.write('data', 36)
  buf.writeUInt32LE(dataSize, 40)
  return buf
}

const ONE_SECOND_WAV = buildWav(16000) // 32000 data bytes / 32000 byteRate -> 1000 ms

const SCRIPT = testScript()

// A 19-word sentence; repeat it to build narration of a known length.
const SENTENCE =
  'Venus spins backwards compared to every other planet orbiting our star and nobody really knows exactly why that happens.'
const SENTENCE_WORDS = 19

// 15 sentences -> 285 narration words, far past kokoro's ~80-word context window.
const LONG_SCRIPT = testScript({
  hook: SENTENCE,
  segments: Array.from({ length: 14 }, () => SENTENCE),
})
const LONG_SCRIPT_WORDS = 15 * SENTENCE_WORDS

const KOKORO_RATE = 24000

// Mock kokoro output: RawAudio-shaped { audio, sampling_rate }, 2 words/sec of
// samples so synthesized length is plausible for the text it was given.
function chunkAudio(text: string): { audio: Float32Array; sampling_rate: number } {
  return {
    audio: new Float32Array(countWords(text) * (KOKORO_RATE / 2)),
    sampling_rate: KOKORO_RATE,
  }
}

// ---- premium (elevenlabs) fixtures ----

const PREMIUM_VOICE = {
  provider: 'elevenlabs',
  voiceId: 'EXAVITQu4vr4xnSDxMaL',
  modelId: 'eleven_multilingual_v2',
} as const

function premiumChannel() {
  return testChannel({ voice: { volume: 'af_heart', premium: { ...PREMIUM_VOICE } } })
}

// The hook and body are sent as one call, but with an explicit SSML break
// between them so ElevenLabs (which understands the tag) leaves a real,
// deliberate pause instead of reading straight through -- see HOOK_PAUSE_MS.
const PREMIUM_NARRATION_WITH_BREAK = `Hook here <break time="${HOOK_PAUSE_MS}ms" />\n\nOne.\n\nTwo.`

const ELEVEN_WAV = buildWav(16000) // 1000 ms — plausible for the 4-word narration
const ELEVEN_WORDS = [
  { word: 'Hook', startMs: 0, endMs: 180 },
  { word: 'here', startMs: 190, endMs: 350 },
  { word: 'One.', startMs: 400, endMs: 620 },
  { word: 'Two.', startMs: 700, endMs: 950 },
]
function elevenSynthResult() {
  return { wavBytes: ELEVEN_WAV, durationMs: 1000, words: ELEVEN_WORDS, costUsdMicros: 42_000 }
}

// The elevenlabs branch is gated purely on ctx.channel.voice.premium being
// configured — no tier concept is involved.
async function premiumCtx(
  script: unknown = SCRIPT,
  channel = premiumChannel(),
): Promise<JobContext> {
  const ctx = makeCtx({ channel })
  await fs.writeFile(ctx.artifactPath('script', 'script.json'), JSON.stringify(script))
  return ctx
}

async function ctxWithScript(script: unknown = SCRIPT): Promise<JobContext> {
  const ctx = makeCtx()
  await fs.writeFile(ctx.artifactPath('script', 'script.json'), JSON.stringify(script))
  return ctx
}

// Hermeticity guard: capture whatever the ambient environment actually had
// for this var (e.g. an operator's own `BRAINROT_DEV_VOICE=1 npx vitest run`,
// exactly as the README instructs) so every test in this file starts from a
// known-clean slate, then restore it once the whole file is done. Without
// this, an ambient BRAINROT_DEV_VOICE=1 would make every premium-configured
// test below silently skip the elevenlabs branch it exists to exercise.
beforeEach(() => {
  vi.clearAllMocks()
  // Stubbing (not deleting) is what lets setup.ts's global vi.unstubAllEnvs()
  // hand the developer's real BRAINROT_DEV_VOICE back after the file.
  vi.stubEnv(DEV_VOICE_ENV, undefined)
})

describe('parseWavDurationMs', () => {
  it('computes duration from data size / byteRate', () => {
    expect(parseWavDurationMs(buildWav(16000))).toBe(1000)
    expect(parseWavDurationMs(buildWav(8000))).toBe(500)
  })
  it('rejects non-RIFF buffers', () => {
    expect(() => parseWavDurationMs(Buffer.from('not a wav file at all'))).toThrow(/RIFF/)
  })
})

describe('voiceStage', () => {
  it('uses kokoro on the happy path and writes wav + meta', async () => {
    const ctx = await ctxWithScript()
    const generate = vi.fn(async (t: string) => chunkAudio(t))
    vi.mocked(KokoroTTS.from_pretrained).mockResolvedValue({ generate } as never)

    await voiceStage.run(ctx)

    // Hook and body are synthesized separately so a real pause can be spliced
    // between them -- each fits in one chunk on its own.
    expect(generate).toHaveBeenCalledTimes(2)
    expect(generate).toHaveBeenNthCalledWith(1, 'Hook here', { voice: 'af_heart' })
    // Chunk packing rejoins sentence pieces with single spaces.
    expect(generate).toHaveBeenNthCalledWith(2, 'One. Two.', { voice: 'af_heart' })
    const meta = JSON.parse(await fs.readFile(ctx.artifactPath('voice', 'voice.json'), 'utf8'))
    // hook 1000ms + HOOK_PAUSE_MS + body 1000ms
    expect(meta).toEqual({
      provider: 'kokoro',
      voiceId: 'af_heart',
      durationMs: 2000 + HOOK_PAUSE_MS,
    })
  })

  it('splits long narration into multiple under-budget kokoro calls and concatenates them', async () => {
    const ctx = await ctxWithScript(LONG_SCRIPT)
    const generate = vi.fn(async (t: string) => chunkAudio(t))
    vi.mocked(KokoroTTS.from_pretrained).mockResolvedValue({ generate } as never)

    await voiceStage.run(ctx)

    const texts = generate.mock.calls.map((c) => c[0])
    // The hook (one sentence, under budget) is synthesized alone, first.
    expect(texts[0]).toBe(SENTENCE)
    const bodyTexts = texts.slice(1)
    expect(bodyTexts.length).toBeGreaterThan(1)
    for (const t of texts) expect(countWords(t)).toBeLessThanOrEqual(MAX_CHUNK_WORDS)
    // Nothing may be dropped: every narration word must appear in some chunk.
    expect(texts.reduce((n, t) => n + countWords(t), 0)).toBe(LONG_SCRIPT_WORDS)

    // Concatenated wav duration == sum of the per-chunk durations, plus the
    // deliberate pause spliced between the hook and the body.
    const expectedMs = texts.reduce((ms, t) => ms + countWords(t) * 500, 0) + HOOK_PAUSE_MS
    const wav = await fs.readFile(ctx.artifactPath('voice', 'narration.wav'))
    expect(parseWavDurationMs(wav)).toBe(expectedMs)
    const meta = JSON.parse(await fs.readFile(ctx.artifactPath('voice', 'voice.json'), 'utf8'))
    expect(meta.durationMs).toBe(expectedMs)
  })

  it('caps per-chunk trailing silence so concatenation has no internal gaps or dead tail', async () => {
    const ctx = await ctxWithScript(LONG_SCRIPT)
    // Each chunk: audible speech at 2 words/sec followed by 3s of pure silence —
    // the shape real kokoro output has (multi-second silent pad per generation).
    const generate = vi.fn(async (t: string) => {
      const speech = countWords(t) * (KOKORO_RATE / 2)
      const audio = new Float32Array(speech + KOKORO_RATE * 3)
      audio.fill(0.5, 0, speech)
      return { audio, sampling_rate: KOKORO_RATE }
    })
    vi.mocked(KokoroTTS.from_pretrained).mockResolvedValue({ generate } as never)

    await voiceStage.run(ctx)

    const texts = generate.mock.calls.map((c) => c[0])
    expect(texts.length).toBeGreaterThan(1)
    // Each chunk keeps its speech plus at most 250ms of tail: the 3s pads are
    // gone both between chunks (internal gaps) and after the last one (tail).
    // Plus the deliberate pause spliced between the hook and the body.
    const expectedMs = texts.reduce((ms, t) => ms + countWords(t) * 500 + 250, 0) + HOOK_PAUSE_MS
    const wav = await fs.readFile(ctx.artifactPath('voice', 'narration.wav'))
    expect(parseWavDurationMs(wav)).toBe(expectedMs)
    const meta = JSON.parse(await fs.readFile(ctx.artifactPath('voice', 'voice.json'), 'utf8'))
    expect(meta.durationMs).toBe(expectedMs)
  })

  it('throws when synthesized audio is implausibly short for the script (truncation guard)', async () => {
    const ctx = await ctxWithScript(LONG_SCRIPT)
    // Simulate silent truncation: every chunk comes back as 100ms of audio.
    const generate = vi.fn().mockResolvedValue({
      audio: new Float32Array(KOKORO_RATE / 10),
      sampling_rate: KOKORO_RATE,
    })
    vi.mocked(KokoroTTS.from_pretrained).mockResolvedValue({ generate } as never)

    await expect(voiceStage.run(ctx)).rejects.toThrow(/truncat/i)
  })

  it('falls back to edge-tts when kokoro throws', async () => {
    const ctx = await ctxWithScript()
    vi.mocked(KokoroTTS.from_pretrained).mockRejectedValue(new Error('no model'))
    const setMetadata = vi.fn().mockResolvedValue(undefined)
    // Hook and body are now separate toStream calls: a fresh Readable per call,
    // since a shared one would be exhausted (empty) on the second read.
    const toStream = vi.fn(() => ({ audioStream: Readable.from([ONE_SECOND_WAV]) }))
    // vitest v4 constructs `new MsEdgeTTS()` via the mock implementation; an arrow
    // function is not a constructor, so use a regular function returning the stub.
    vi.mocked(MsEdgeTTS).mockImplementation(function () {
      return { setMetadata, toStream }
    })

    await voiceStage.run(ctx)

    const meta = JSON.parse(await fs.readFile(ctx.artifactPath('voice', 'voice.json'), 'utf8'))
    // Hook and body each resolve to the mocked 1000ms wav, plus the spliced pause.
    expect(meta).toEqual({
      provider: 'edge-tts',
      voiceId: 'en-US-AriaNeural',
      durationMs: 2000 + HOOK_PAUSE_MS,
    })
  })

  it('chunks and concatenates on the edge-tts path too', async () => {
    const ctx = await ctxWithScript(LONG_SCRIPT)
    vi.mocked(KokoroTTS.from_pretrained).mockRejectedValue(new Error('no model'))
    const setMetadata = vi.fn().mockResolvedValue(undefined)
    // Each edge response is its own RIFF stream: 12s per chunk keeps the total
    // above the truncation guard's plausibility floor.
    const toStream = vi.fn((t: string) => ({
      text: t,
      audioStream: Readable.from([buildWav(16000 * 12)]),
    }))
    vi.mocked(MsEdgeTTS).mockImplementation(function () {
      return { setMetadata, toStream }
    })

    await voiceStage.run(ctx)

    const texts = toStream.mock.calls.map((c) => c[0])
    expect(texts.length).toBeGreaterThan(1)
    for (const t of texts) expect(countWords(t)).toBeLessThanOrEqual(MAX_CHUNK_WORDS)
    // PCM payloads concatenate into one valid wav of the summed duration, plus
    // the deliberate pause spliced between the hook and the body.
    const wav = await fs.readFile(ctx.artifactPath('voice', 'narration.wav'))
    expect(parseWavDurationMs(wav)).toBe(texts.length * 12000 + HOOK_PAUSE_MS)
  })

  it('throws when both kokoro and edge-tts fail', async () => {
    const ctx = await ctxWithScript()
    vi.mocked(KokoroTTS.from_pretrained).mockRejectedValue(new Error('no model'))
    vi.mocked(MsEdgeTTS).mockImplementation(function () {
      return {
        setMetadata: vi.fn().mockResolvedValue(undefined),
        toStream: vi.fn(() => {
          throw new Error('edge down')
        }),
      }
    })

    await expect(voiceStage.run(ctx)).rejects.toThrow(/voice synthesis failed/)
  })
})

describe('voiceStage with [voice.premium] configured (elevenlabs)', () => {
  it('synthesizes via elevenlabs: wav + timings + meta written, cost recorded, volume chain untouched', async () => {
    const ctx = await premiumCtx()
    vi.mocked(synthWithTimestamps).mockResolvedValue(elevenSynthResult())
    // Kokoro is armed so that, if the implementation wrongly falls through to
    // the volume chain, this test fails on assertions instead of crashing.
    const generate = vi.fn(async (t: string) => chunkAudio(t))
    vi.mocked(KokoroTTS.from_pretrained).mockResolvedValue({ generate } as never)

    await voiceStage.run(ctx)

    expect(vi.mocked(synthWithTimestamps)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(synthWithTimestamps)).toHaveBeenCalledWith({
      voiceId: 'EXAVITQu4vr4xnSDxMaL',
      modelId: 'eleven_multilingual_v2',
      text: PREMIUM_NARRATION_WITH_BREAK,
    })
    expect(vi.mocked(KokoroTTS.from_pretrained)).not.toHaveBeenCalled()

    const wav = await fs.readFile(ctx.artifactPath('voice', 'narration.wav'))
    expect(wav.equals(ELEVEN_WAV)).toBe(true)
    const meta = JSON.parse(await fs.readFile(ctx.artifactPath('voice', 'voice.json'), 'utf8'))
    expect(meta).toEqual({
      provider: 'elevenlabs',
      voiceId: 'EXAVITQu4vr4xnSDxMaL',
      durationMs: 1000,
    })
    const timings = JSON.parse(await fs.readFile(ctx.artifactPath('voice', 'timings.json'), 'utf8'))
    expect(timings).toEqual({ words: ELEVEN_WORDS })

    // Ledger: the estimate is reserved pre-call (against the SSML-augmented
    // text actually sent, never the shorter plain narration), the ACTUAL cost
    // is recorded from the same call.
    expect(vi.mocked(estimateTtsCostMicros)).toHaveBeenCalledWith(PREMIUM_NARRATION_WITH_BREAK)
    const costs = ctx.db
      .prepare('SELECT provider, operation, usd_micros FROM costs WHERE job_id = ?')
      .all(ctx.jobId)
    expect(costs).toEqual([{ provider: 'elevenlabs', operation: 'tts', usd_micros: 42_000 }])
  })

  it('strips any leaked SSML break-tag fragments out of the returned word timings', async () => {
    const ctx = await premiumCtx()
    vi.mocked(synthWithTimestamps).mockResolvedValue({
      ...elevenSynthResult(),
      // Defense in depth: if a provider ever echoes the injected break tag
      // back into its character alignment instead of consuming it as markup,
      // the leaked fragments must not reach captions.
      words: [
        ...ELEVEN_WORDS,
        { word: '<break', startMs: 960, endMs: 970 },
        { word: `time="${HOOK_PAUSE_MS}ms"`, startMs: 970, endMs: 980 },
        { word: '/>', startMs: 980, endMs: 990 },
      ],
    })
    const generate = vi.fn(async (t: string) => chunkAudio(t))
    vi.mocked(KokoroTTS.from_pretrained).mockResolvedValue({ generate } as never)

    await voiceStage.run(ctx)

    const timings = JSON.parse(await fs.readFile(ctx.artifactPath('voice', 'timings.json'), 'utf8'))
    expect(timings).toEqual({ words: ELEVEN_WORDS })
  })

  it('falls back to kokoro when elevenlabs fails, leaving no timings.json and no cost row', async () => {
    const ctx = await premiumCtx()
    vi.mocked(synthWithTimestamps).mockRejectedValue(new Error('eleven down'))
    const generate = vi.fn(async (t: string) => chunkAudio(t))
    vi.mocked(KokoroTTS.from_pretrained).mockResolvedValue({ generate } as never)

    await voiceStage.run(ctx)

    const meta = JSON.parse(await fs.readFile(ctx.artifactPath('voice', 'voice.json'), 'utf8'))
    expect(meta.provider).toBe('kokoro')
    expect(meta.voiceId).toBe('af_heart')
    // No timings artifact: captions must take the WhisperX path for this job.
    await expect(fs.access(ctx.artifactPath('voice', 'timings.json'))).rejects.toThrow()
    // Only elevenlabs SUCCESSES may reach the ledger.
    const { n } = ctx.db
      .prepare('SELECT COUNT(*) AS n FROM costs WHERE job_id = ?')
      .get(ctx.jobId) as { n: number }
    expect(n).toBe(0)
  })

  it('fails the stage instead of falling back when a local write throws after paid audio arrived', async () => {
    const ctx = await premiumCtx()
    vi.mocked(synthWithTimestamps).mockResolvedValue(elevenSynthResult())
    const generate = vi.fn(async (t: string) => chunkAudio(t))
    vi.mocked(KokoroTTS.from_pretrained).mockResolvedValue({ generate } as never)
    // Everything after the provider call sits outside the fallback catch, so a
    // disk failure on the wav write surfaces as a stage error.
    const realWriteFile = fs.writeFile.bind(fs)
    const writeFile = vi.spyOn(fs, 'writeFile').mockImplementation((async (
      file: unknown,
      data: unknown,
    ) => {
      if (String(file).endsWith('narration.wav')) throw new Error('ENOSPC: no space left on device')
      return realWriteFile(file as string, data as string)
    }) as never)

    try {
      await expect(voiceStage.run(ctx)).rejects.toThrow(/ENOSPC/)
    } finally {
      writeFile.mockRestore()
    }

    // The provider delivered audio, so the charge is real: it belongs on the
    // ledger even though the stage went on to fail.
    const costs = ctx.db
      .prepare('SELECT provider, operation, usd_micros FROM costs WHERE job_id = ?')
      .all(ctx.jobId)
    expect(costs).toEqual([{ provider: 'elevenlabs', operation: 'tts', usd_micros: 42_000 }])
    // No silent downgrade: the volume chain must not have run.
    expect(generate).not.toHaveBeenCalled()
  })

  it('removes a stale timings.json from a prior attempt when falling back', async () => {
    const ctx = await premiumCtx()
    await fs.writeFile(
      ctx.artifactPath('voice', 'timings.json'),
      JSON.stringify({ words: ELEVEN_WORDS }),
    )
    vi.mocked(synthWithTimestamps).mockRejectedValue(new Error('eleven down'))
    const generate = vi.fn(async (t: string) => chunkAudio(t))
    vi.mocked(KokoroTTS.from_pretrained).mockResolvedValue({ generate } as never)

    await voiceStage.run(ctx)

    await expect(fs.access(ctx.artifactPath('voice', 'timings.json'))).rejects.toThrow()
    const meta = JSON.parse(await fs.readFile(ctx.artifactPath('voice', 'voice.json'), 'utf8'))
    expect(meta.provider).toBe('kokoro')
  })

  it('a channel with no [voice.premium] config uses the volume chain', async () => {
    const ctx = await premiumCtx(SCRIPT, testChannel({ voice: { volume: 'af_heart' } }))
    const generate = vi.fn(async (t: string) => chunkAudio(t))
    vi.mocked(KokoroTTS.from_pretrained).mockResolvedValue({ generate } as never)

    await voiceStage.run(ctx)

    expect(vi.mocked(synthWithTimestamps)).not.toHaveBeenCalled()
    const meta = JSON.parse(await fs.readFile(ctx.artifactPath('voice', 'voice.json'), 'utf8'))
    expect(meta.provider).toBe('kokoro')
  })

  it('rethrows BudgetExceededError instead of downgrading to the free chain', async () => {
    const channel = premiumChannel()
    // estimateTtsCostMicros mock returns 40_000; cap it below that.
    channel.budget = { ...channel.budget, perVideoUsdMicros: 10_000 }
    const ctx = await premiumCtx(SCRIPT, channel)
    const generate = vi.fn(async (t: string) => chunkAudio(t))
    vi.mocked(KokoroTTS.from_pretrained).mockResolvedValue({ generate } as never)

    await expect(voiceStage.run(ctx)).rejects.toBeInstanceOf(BudgetExceededError)

    // Aborted before any synthesis: no provider dialed, no artifacts written.
    expect(vi.mocked(synthWithTimestamps)).not.toHaveBeenCalled()
    expect(generate).not.toHaveBeenCalled()
    await expect(fs.access(ctx.artifactPath('voice', 'voice.json'))).rejects.toThrow()
  })

  it('applies the implausibly-short truncation guard to elevenlabs audio too', async () => {
    // LONG_SCRIPT: 285 narration words -> >= 57000ms plausibility floor, but
    // the mock returns 1000ms of audio.
    const ctx = await premiumCtx(LONG_SCRIPT)
    vi.mocked(synthWithTimestamps).mockResolvedValue(elevenSynthResult())

    await expect(voiceStage.run(ctx)).rejects.toThrow(/truncated by provider "elevenlabs"/)
    // The ABSENT guarantee holds on this failure path too: the timings write is
    // deferred until after the duration guard, so the rejected synthesis leaves
    // no timings.json for captions to trust (and no voice.json either).
    await expect(fs.access(ctx.artifactPath('voice', 'timings.json'))).rejects.toThrow()
    await expect(fs.access(ctx.artifactPath('voice', 'voice.json'))).rejects.toThrow()
  })
})

describe('voiceStage dev mode', () => {
  it('channel.voice.dev=true skips elevenlabs and its budget check even when premium is configured', async () => {
    const channel = premiumChannel()
    channel.voice = { ...channel.voice, dev: true }
    // Cap set below the mocked 40_000 elevenlabs estimate: if dev mode did not
    // skip the premium branch entirely, this would throw BudgetExceededError
    // instead of falling through to kokoro.
    channel.budget = { ...channel.budget, perVideoUsdMicros: 10_000 }
    const ctx = await premiumCtx(SCRIPT, channel)
    const generate = vi.fn(async (t: string) => chunkAudio(t))
    vi.mocked(KokoroTTS.from_pretrained).mockResolvedValue({ generate } as never)

    await voiceStage.run(ctx)

    expect(vi.mocked(estimateTtsCostMicros)).not.toHaveBeenCalled()
    expect(vi.mocked(synthWithTimestamps)).not.toHaveBeenCalled()
    const meta = JSON.parse(await fs.readFile(ctx.artifactPath('voice', 'voice.json'), 'utf8'))
    expect(meta.provider).toBe('kokoro')
  })

  it('BRAINROT_DEV_VOICE=1 skips elevenlabs even when the channel has no dev flag set', async () => {
    vi.stubEnv(DEV_VOICE_ENV, '1')
    const ctx = await premiumCtx()
    const generate = vi.fn(async (t: string) => chunkAudio(t))
    vi.mocked(KokoroTTS.from_pretrained).mockResolvedValue({ generate } as never)

    await voiceStage.run(ctx)

    expect(vi.mocked(synthWithTimestamps)).not.toHaveBeenCalled()
    const meta = JSON.parse(await fs.readFile(ctx.artifactPath('voice', 'voice.json'), 'utf8'))
    expect(meta.provider).toBe('kokoro')
  })

  it('leaves premium behavior untouched when BRAINROT_DEV_VOICE is unset or not "1"', async () => {
    vi.stubEnv(DEV_VOICE_ENV, '0')
    const ctx = await premiumCtx()
    vi.mocked(synthWithTimestamps).mockResolvedValue(elevenSynthResult())

    await voiceStage.run(ctx)

    expect(vi.mocked(synthWithTimestamps)).toHaveBeenCalledTimes(1)
  })
})
