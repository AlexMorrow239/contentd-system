import { promises as fs } from 'node:fs'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../../../infra/providers/elevenlabs.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../infra/providers/elevenlabs.js')>()),
  synthWithTimestamps: vi.fn(),
}))

import { testChannel } from '../../../../../testing/channel.js'
import { makeCtx, testScript, writeScriptJson } from '../../../../../testing/job.js'
import { encodePcmWav } from '../../../../infra/media/wav.js'
import { synthWithTimestamps } from '../../../../infra/providers/elevenlabs.js'
import { ContentdError, classify } from '../../../../shared/errors.js'
import { BudgetExceededError } from '../../../billing/costs.js'
import { voiceStage } from '../voice.js'

const WAV = encodePcmWav([Buffer.alloc(32_000)], 16_000, 1)
const WORDS = [
  { word: 'Hook', startMs: 0, endMs: 180 },
  { word: 'here', startMs: 190, endMs: 350 },
  { word: 'One.', startMs: 400, endMs: 620 },
  { word: 'Two.', startMs: 700, endMs: 950 },
]
const result = () => ({ wavBytes: WAV, durationMs: 1000, words: WORDS, costUsdMicros: 42_000 })
const ctxWithScript = () => writeScriptJson(makeCtx(), testScript())

beforeEach(() => vi.resetAllMocks())

describe('voiceStage', () => {
  it('propagates an ElevenLabs rejection without synthesizing a replacement', async () => {
    const ctx = ctxWithScript()
    const failure = new ContentdError('elevenlabs responded 402: paid_plan_required', {
      domain: 'provider',
      kind: 'transient',
    })
    vi.mocked(synthWithTimestamps).mockRejectedValueOnce(failure)
    await expect(voiceStage.run(ctx)).rejects.toBe(failure)
    await expect(fs.access(ctx.artifactPath('voice', 'voice.json'))).rejects.toThrow()
    await expect(fs.access(ctx.artifactPath('voice', 'narration.wav'))).rejects.toThrow()
    expect(ctx.db.prepare('SELECT COUNT(*) AS n FROM costs').get()).toEqual({ n: 0 })
  })

  it('fails with missing credentials before any network activity or audio output', async () => {
    vi.stubEnv('ELEVENLABS_API_KEY', '')
    const actual = await vi.importActual<
      typeof import('../../../../infra/providers/elevenlabs.js')
    >('../../../../infra/providers/elevenlabs.js')
    vi.mocked(synthWithTimestamps).mockImplementationOnce(actual.synthWithTimestamps)
    const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('unexpected network'))
    const ctx = ctxWithScript()
    try {
      const error = await voiceStage.run(ctx).catch((err: unknown) => err)
      expect(error).toBeInstanceOf(ContentdError)
      expect(String(error)).toMatch(/missing ElevenLabs API key/)
      expect(classify(error)).toMatchObject({ domain: 'config', kind: 'invalid' })
      expect(fetch).not.toHaveBeenCalled()
      await expect(fs.access(ctx.artifactPath('voice', 'voice.json'))).rejects.toThrow()
      expect(ctx.db.prepare('SELECT COUNT(*) AS n FROM costs').get()).toEqual({ n: 0 })
    } finally {
      fetch.mockRestore()
    }
  })

  it('writes paid audio, timings and configured voice metadata with actual cost', async () => {
    const ctx = ctxWithScript()
    ctx.channel = testChannel({ voice: { voiceId: 'chosen-voice', modelId: 'chosen-model' } })
    vi.mocked(synthWithTimestamps).mockResolvedValueOnce(result())
    await voiceStage.run(ctx)
    expect(synthWithTimestamps).toHaveBeenCalledWith({
      signal: undefined,
      time: ctx.time,
      voiceId: 'chosen-voice',
      modelId: 'chosen-model',
      text: 'Hook here <break time="500ms" />\n\nOne.\n\nTwo.',
    })
    expect(await fs.readFile(ctx.artifactPath('voice', 'narration.wav'))).toEqual(WAV)
    expect(JSON.parse(await fs.readFile(ctx.artifactPath('voice', 'voice.json'), 'utf8'))).toEqual({
      provider: 'elevenlabs',
      voiceId: 'chosen-voice',
      durationMs: 1000,
    })
    expect(
      JSON.parse(await fs.readFile(ctx.artifactPath('voice', 'timings.json'), 'utf8')),
    ).toEqual({ words: WORDS })
    expect(ctx.db.prepare('SELECT provider, operation, usd_micros FROM costs').all()).toEqual([
      { provider: 'elevenlabs', operation: 'tts', usd_micros: 42_000 },
    ])
  })

  it('strips leaked SSML fragments from word timings', async () => {
    const ctx = ctxWithScript()
    vi.mocked(synthWithTimestamps).mockResolvedValueOnce({
      ...result(),
      words: [
        ...WORDS,
        { word: '<break', startMs: 960, endMs: 970 },
        { word: 'time="500ms"', startMs: 970, endMs: 980 },
        { word: '/>', startMs: 980, endMs: 990 },
      ],
    })
    await voiceStage.run(ctx)
    expect(
      JSON.parse(await fs.readFile(ctx.artifactPath('voice', 'timings.json'), 'utf8')),
    ).toEqual({ words: WORDS })
  })

  it('ledgers paid audio arriving after cancellation without writing it', async () => {
    const ctx = ctxWithScript()
    const controller = new AbortController()
    ctx.signal = controller.signal
    const lost = new Error('lease lost')
    vi.mocked(synthWithTimestamps).mockImplementationOnce(async () => {
      controller.abort(lost)
      return result()
    })
    await expect(voiceStage.run(ctx)).rejects.toBe(lost)
    expect(ctx.db.prepare('SELECT SUM(usd_micros) AS cost FROM costs').get()).toEqual({
      cost: 42_000,
    })
    await expect(fs.access(ctx.artifactPath('voice', 'narration.wav'))).rejects.toThrow()
  })

  it('does not synthesize an already cancelled attempt', async () => {
    const ctx = ctxWithScript()
    const lost = new Error('lease lost')
    ctx.signal = AbortSignal.abort(lost)
    await expect(voiceStage.run(ctx)).rejects.toBe(lost)
    expect(synthWithTimestamps).not.toHaveBeenCalled()
  })

  it('retains actual spend when writing delivered audio fails', async () => {
    const ctx = ctxWithScript()
    vi.mocked(synthWithTimestamps).mockResolvedValueOnce(result())
    const realWriteFile = fs.writeFile.bind(fs)
    const writeFile = vi.spyOn(fs, 'writeFile').mockImplementation(async (file, data, options) => {
      if (typeof file === 'string' && file.endsWith('narration.wav')) throw new Error('ENOSPC')
      return realWriteFile(file, data, options)
    })
    try {
      await expect(voiceStage.run(ctx)).rejects.toThrow(/ENOSPC/)
    } finally {
      writeFile.mockRestore()
    }
    expect(ctx.db.prepare('SELECT SUM(usd_micros) AS cost FROM costs').get()).toEqual({
      cost: 42_000,
    })
    await expect(fs.access(ctx.artifactPath('voice', 'timings.json'))).rejects.toThrow()
  })

  it('removes stale timings when synthesis fails', async () => {
    const ctx = ctxWithScript()
    await fs.writeFile(ctx.artifactPath('voice', 'timings.json'), JSON.stringify({ words: WORDS }))
    vi.mocked(synthWithTimestamps).mockRejectedValueOnce(new Error('eleven down'))
    await expect(voiceStage.run(ctx)).rejects.toThrow('eleven down')
    await expect(fs.access(ctx.artifactPath('voice', 'timings.json'))).rejects.toThrow()
  })

  it('enforces the budget before synthesis', async () => {
    const ctx = ctxWithScript()
    ctx.channel.budget = { perDayUsdMicros: 1 }
    await expect(voiceStage.run(ctx)).rejects.toBeInstanceOf(BudgetExceededError)
    expect(synthWithTimestamps).not.toHaveBeenCalled()
    await expect(fs.access(ctx.artifactPath('voice', 'voice.json'))).rejects.toThrow()
  })

  it('rejects implausibly short paid audio without publishing timings', async () => {
    const ctx = writeScriptJson(makeCtx(), testScript({ hook: 'word '.repeat(285) }))
    vi.mocked(synthWithTimestamps).mockResolvedValueOnce(result())
    await expect(voiceStage.run(ctx)).rejects.toThrow(/truncated by provider "elevenlabs"/)
    await expect(fs.access(ctx.artifactPath('voice', 'timings.json'))).rejects.toThrow()
    await expect(fs.access(ctx.artifactPath('voice', 'voice.json'))).rejects.toThrow()
    expect(ctx.db.prepare('SELECT SUM(usd_micros) AS cost FROM costs').get()).toEqual({
      cost: 42_000,
    })
  })
})
