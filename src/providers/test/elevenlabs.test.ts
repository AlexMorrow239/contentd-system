import { describe, it, expect, vi, afterEach } from 'vitest'
import { parseWav } from '../../media/wav.js'
import { classify, errorMessage } from '../../errors.js'
import {
  ELEVENLABS_USD_MICROS_PER_1K_CHARS,
  estimateTtsCostMicros,
  synthWithTimestamps,
} from '../elevenlabs.js'

afterEach(() => {
  vi.unstubAllEnvs()
})

// Recorded-style /with-timestamps response for the text 'Hi,  there!' (11 chars,
// double space). audio_base64 is 48,000 bytes of 16-bit mono PCM: at 24 kHz that
// is exactly 1000 ms of audio.
const FIXTURE = {
  audio_base64: Buffer.alloc(48_000).toString('base64'),
  alignment: {
    characters: ['H', 'i', ',', ' ', ' ', 't', 'h', 'e', 'r', 'e', '!'],
    character_start_times_seconds: [
      0, 0.058, 0.116, 0.174, 0.19, 0.209, 0.267, 0.325, 0.383, 0.441, 0.499,
    ],
    character_end_times_seconds: [
      0.058, 0.116, 0.174, 0.19, 0.209, 0.267, 0.325, 0.383, 0.441, 0.499, 0.557,
    ],
  },
}

// Injectable fetch: captures every call, answers with one canned JSON response.
function fakeFetch(status: number, body: unknown) {
  const calls: { url: string; init: RequestInit | undefined }[] = []
  const impl: typeof fetch = async (input, init) => {
    calls.push({ url: input instanceof Request ? input.url : String(input), init })
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    })
  }
  return { impl, calls }
}

describe('estimateTtsCostMicros', () => {
  it('charges the per-1k-character overage rate with ceil rounding', () => {
    expect(ELEVENLABS_USD_MICROS_PER_1K_CHARS).toBe(300_000)
    expect(estimateTtsCostMicros('a'.repeat(1000))).toBe(300_000) // exactly $0.30
    expect(estimateTtsCostMicros('ab')).toBe(600) // ceil(2 * 300_000 / 1000)
    expect(estimateTtsCostMicros('')).toBe(0)
  })
})

describe('synthWithTimestamps', () => {
  it('propagates caller cancellation during a request without relabeling it as timeout', async () => {
    const controller = new AbortController()
    const lost = new Error('lease lost')
    const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
      controller.abort(lost)
      init?.signal?.throwIfAborted()
      throw new Error('caller signal was not propagated')
    })
    await expect(
      synthWithTimestamps({
        voiceId: 'v',
        modelId: 'm',
        text: 'hello',
        apiKey: 'test',
        signal: controller.signal,
        fetchImpl,
      }),
    ).rejects.toBe(lost)
  })

  it('does not call the endpoint for an already cancelled request', async () => {
    const lost = new Error('lease lost')
    const fetchImpl = vi.fn()
    await expect(
      synthWithTimestamps({
        voiceId: 'v',
        modelId: 'm',
        text: 'hello',
        apiKey: 'test',
        signal: AbortSignal.abort(lost),
        fetchImpl,
      }),
    ).rejects.toBe(lost)
    expect(fetchImpl).not.toHaveBeenCalled()
  })
  it('POSTs the synthesis request and returns wav bytes plus grouped word timings', async () => {
    const { impl, calls } = fakeFetch(200, FIXTURE)
    const res = await synthWithTimestamps({
      voiceId: 'EXAVITQu4vr4xnSDxMaL',
      modelId: 'eleven_multilingual_v2',
      text: 'Hi,  there!',
      apiKey: 'k-test',
      fetchImpl: impl,
    })

    // Request shape: endpoint + PCM output format + auth header + JSON body.
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe(
      'https://api.elevenlabs.io/v1/text-to-speech/EXAVITQu4vr4xnSDxMaL/with-timestamps?output_format=pcm_24000',
    )
    const init = calls[0].init!
    expect(init.method).toBe('POST')
    expect((init.headers as Record<string, string>)['xi-api-key']).toBe('k-test')
    expect(JSON.parse(init.body as string)).toEqual({
      text: 'Hi,  there!',
      model_id: 'eleven_multilingual_v2',
    })

    // The raw PCM is wrapped in a canonical RIFF/WAVE container at 24 kHz mono.
    const wav = parseWav(res.wavBytes)
    expect(wav.sampleRate).toBe(24_000)
    expect(wav.channels).toBe(1)
    expect(wav.data.length).toBe(48_000)
    expect(res.durationMs).toBe(1000)

    // Character runs group into words: punctuation stays attached, the double
    // space produces no empty word, times are integer ms.
    expect(res.words).toEqual([
      { word: 'Hi,', startMs: 0, endMs: 174 },
      { word: 'there!', startMs: 209, endMs: 557 },
    ])

    // 11 characters at $0.30/1k → ceil(11 * 300_000 / 1000) = 3300 micros.
    expect(res.costUsdMicros).toBe(3300)
  })

  it('returns empty words when the response carries no alignment (audio still usable)', async () => {
    // 4800 PCM bytes at 24 kHz mono 16-bit = 100 ms.
    const { impl } = fakeFetch(200, {
      audio_base64: Buffer.alloc(4800).toString('base64'),
      alignment: null,
    })
    const res = await synthWithTimestamps({
      voiceId: 'v',
      modelId: 'm',
      text: 'x',
      apiKey: 'k',
      fetchImpl: impl,
    })
    expect(res.words).toEqual([])
    expect(res.durationMs).toBe(100)
  })

  it('discards an alignment whose timing arrays disagree in length (paid audio still returned)', async () => {
    // A partial alignment indexed positionally yields undefined timings and NaN
    // milliseconds; empty words instead routes the paid audio to WhisperX.
    const { impl } = fakeFetch(200, {
      audio_base64: Buffer.alloc(4800).toString('base64'),
      alignment: {
        characters: ['H', 'i', '!'],
        character_start_times_seconds: [0, 0.1],
        character_end_times_seconds: [0.1, 0.2],
      },
    })
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const res = await synthWithTimestamps({
        voiceId: 'v',
        modelId: 'm',
        text: 'Hi!',
        apiKey: 'k',
        fetchImpl: impl,
      })
      expect(res.words).toEqual([])
      expect(res.durationMs).toBe(100)
      expect(err).toHaveBeenCalledTimes(1)
    } finally {
      err.mockRestore()
    }
  })

  it('discards an alignment carrying non-finite timings (paid audio still returned)', async () => {
    const { impl } = fakeFetch(200, {
      audio_base64: Buffer.alloc(4800).toString('base64'),
      alignment: {
        characters: ['H', 'i'],
        character_start_times_seconds: [0, null],
        character_end_times_seconds: [0.1, 0.2],
      },
    })
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const res = await synthWithTimestamps({
        voiceId: 'v',
        modelId: 'm',
        text: 'Hi',
        apiKey: 'k',
        fetchImpl: impl,
      })
      expect(res.words).toEqual([])
      expect(err).toHaveBeenCalledTimes(1)
    } finally {
      err.mockRestore()
    }
  })

  it('throws naming the provider when the response carries no audio, classified as provider/invalid', async () => {
    const { impl } = fakeFetch(200, { alignment: null })
    const err = await synthWithTimestamps({
      voiceId: 'v',
      modelId: 'm',
      text: 'x',
      apiKey: 'k',
      fetchImpl: impl,
    }).catch((e: unknown) => e)
    expect(errorMessage(err)).toMatch(/elevenlabs response carried no audio/)
    expect(classify(err)).toMatchObject({ domain: 'provider', kind: 'invalid' })
  })

  it('classifies a timed-out/aborted request as provider/transient', async () => {
    // synthWithTimestamps has no injectable timeoutMs (unlike whisperx's
    // alignTranscript), and its TIMEOUT_MS is a fixed 120s -- far too slow to
    // wait out for real in a test. The fetchImpl seam it does expose lets this
    // simulate the same isAbortLike(err) branch directly: reject with the shape
    // AbortSignal.timeout() produces on expiry.
    const impl: typeof fetch = async () => {
      throw Object.assign(new Error('The operation was aborted due to timeout'), {
        name: 'TimeoutError',
      })
    }
    const err = await synthWithTimestamps({
      voiceId: 'v',
      modelId: 'm',
      text: 'x',
      apiKey: 'k',
      fetchImpl: impl,
    }).catch((e: unknown) => e)
    expect(errorMessage(err)).toMatch(/elevenlabs request timed out/)
    expect(classify(err)).toMatchObject({ domain: 'provider', kind: 'transient' })
  })

  it('throws before any network call when no API key is available, classified as config/invalid', async () => {
    vi.stubEnv('ELEVENLABS_API_KEY', '')
    const { impl, calls } = fakeFetch(200, FIXTURE)
    const err = await synthWithTimestamps({
      voiceId: 'v',
      modelId: 'm',
      text: 'x',
      fetchImpl: impl,
    }).catch((e: unknown) => e)
    expect(err).toMatchObject({ message: expect.stringMatching(/ELEVENLABS_API_KEY/) })
    expect(classify(err)).toMatchObject({ domain: 'config', kind: 'invalid' })
    expect(calls).toHaveLength(0)
  })

  it('throws with the HTTP status on a non-2xx response, classified as provider/auth for 401', async () => {
    const { impl } = fakeFetch(401, { detail: { status: 'invalid_api_key' } })
    const err = await synthWithTimestamps({
      voiceId: 'v',
      modelId: 'm',
      text: 'x',
      apiKey: 'bad',
      fetchImpl: impl,
    }).catch((e: unknown) => e)
    expect(errorMessage(err)).toMatch(/elevenlabs responded 401/)
    expect(classify(err)).toMatchObject({ domain: 'provider', kind: 'auth' })
  })

  it('throws with the HTTP status on a non-2xx response, classified as provider/transient for a non-auth status', async () => {
    const { impl } = fakeFetch(500, { detail: 'internal server error' })
    const err = await synthWithTimestamps({
      voiceId: 'v',
      modelId: 'm',
      text: 'x',
      apiKey: 'k',
      fetchImpl: impl,
    }).catch((e: unknown) => e)
    expect(errorMessage(err)).toMatch(/elevenlabs responded 500/)
    expect(classify(err)).toMatchObject({ domain: 'provider', kind: 'transient' })
  })
})
