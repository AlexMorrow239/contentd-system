import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createTestTime } from '../../../../testing/time.js'
import { tmpDir } from '../../../../testing/tmp.js'
import { classify } from '../../../shared/errors.js'
import type { TimeSource } from '../../../shared/time.js'
import { redditSource } from '../../sources/reddit.js'
import { synthWithTimestamps } from '../elevenlabs.js'
import { alignTranscript } from '../whisperx.js'

type Request = (time: TimeSource, fetchImpl: typeof fetch, signal?: AbortSignal) => Promise<unknown>
const requests: { name: string; ms: number; request: Request; body: unknown }[] = [
  {
    name: 'whisperx',
    ms: 120_000,
    body: { words: [] },
    request(time, fetchImpl, signal) {
      const wavPath = join(tmpDir('deadline-wav-'), 'audio.wav')
      writeFileSync(wavPath, 'RIFFxxxxWAVEdummy')
      return alignTranscript({
        baseUrl: 'https://example.invalid',
        wavPath,
        transcript: 'test',
        time,
        fetchImpl,
        signal,
      })
    },
  },
  {
    name: 'elevenlabs',
    ms: 120_000,
    body: { audio_base64: 'AAAAAA==', alignment: null },
    request: (time, fetchImpl, signal) =>
      synthWithTimestamps({
        voiceId: 'v',
        modelId: 'm',
        text: 'test',
        apiKey: 'test',
        time,
        fetchImpl,
        signal,
      }),
  },
  {
    name: 'reddit',
    ms: 10_000,
    body: { data: [] },
    request: (time, fetchImpl, signal) =>
      redditSource('space', fetchImpl).fetch({ limit: 1, timeoutMs: 10_000, time, signal }),
  },
]

describe.each(requests)('$name time source deadline', ({ name, ms, request, body }) => {
  it.each(['headers', 'body'] as const)(
    'times out while waiting for %s without real waiting',
    async (phase) => {
      const time = createTestTime(0)
      let entered!: () => void
      const started = new Promise<void>((resolve) => {
        entered = resolve
      })
      let signal!: AbortSignal
      const fetchImpl: typeof fetch = async (_url, opts) => {
        signal = opts!.signal!
        entered()
        if (phase === 'headers')
          return new Promise<Response>((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(signal.reason as Error), { once: true })
          })
        return new Response(
          new ReadableStream({
            start(controller) {
              signal.addEventListener('abort', () => controller.error(signal.reason), {
                once: true,
              })
            },
          }),
        )
      }
      const observed = request(time, fetchImpl).then(
        () => undefined,
        (err: unknown) => err,
      )
      await started
      await time.advanceBy(ms - 1)
      expect(signal.aborted).toBe(false)
      await time.advanceBy(1)
      expect(signal.reason).toMatchObject({ name: 'TimeoutError' })
      const error = await observed
      expect(error).toBeInstanceOf(Error)
      if (name !== 'reddit')
        expect(classify(error)).toMatchObject({ domain: 'provider', kind: 'transient' })
      expect(time.pendingTimerCount()).toBe(0)
    },
  )

  it.each(['headers', 'body'] as const)(
    'preserves parent cancellation during %s and cleans up its deadline',
    async (phase) => {
      const time = createTestTime(0)
      const parent = new AbortController()
      const lost = new Error('ownership lost')
      let entered!: () => void
      const started = new Promise<void>((resolve) => {
        entered = resolve
      })
      const fetchImpl: typeof fetch = async (_url, opts) => {
        if (phase === 'body') {
          const response = new Response(
            new ReadableStream({
              start(controller) {
                opts!.signal!.addEventListener(
                  'abort',
                  () =>
                    controller.error(new DOMException('The operation was aborted.', 'AbortError')),
                  { once: true },
                )
              },
            }),
          )
          entered()
          return response
        }
        return new Promise<Response>((_resolve, reject) => {
          opts!.signal!.addEventListener('abort', () => reject(opts!.signal!.reason as Error), {
            once: true,
          })
          entered()
        })
      }
      const observed = request(time, fetchImpl, parent.signal).catch((err: unknown) => err)
      await started
      parent.abort(lost)
      expect(await observed).toBe(lost)
      expect(time.pendingTimerCount()).toBe(0)
    },
  )

  it('disposes deadlines after successful body consumption', async () => {
    const time = createTestTime(0)
    const fetchImpl: typeof fetch = async () => Response.json(body)
    await request(time, fetchImpl)
    expect(time.pendingTimerCount()).toBe(0)
    await time.advanceBy(ms)
    expect(time.pendingTimerCount()).toBe(0)
  })
})
