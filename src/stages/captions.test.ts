import { describe, it, expect, vi, beforeEach } from 'vitest'
import { promises as fs } from 'node:fs'

vi.mock('../providers/whisperx.js', () => ({ alignTranscript: vi.fn() }))

import { alignTranscript } from '../providers/whisperx.js'
import { captionsStage } from './captions.js'
import { makeCtx } from './_testkit.js'
import type { JobContext } from '../jobs/types.js'

const SCRIPT = {
  hook: 'Hook here',
  segments: [
    { text: 'One.', visualDirection: 'a' },
    { text: 'Two.', visualDirection: 'b' },
  ],
  platformMeta: {
    youtube: { title: 't', description: 'd', hashtags: [] },
    tiktok: { title: 't', description: 'd', hashtags: [] },
    instagram: { title: 't', description: 'd', hashtags: [] },
  },
}

async function ctxWithScript(): Promise<JobContext> {
  const ctx = makeCtx()
  await fs.writeFile(ctx.artifactPath('script', 'script.json'), JSON.stringify(SCRIPT))
  return ctx
}

beforeEach(() => vi.clearAllMocks())

describe('captionsStage', () => {
  it('writes words.json with integer-ms timings from the aligner', async () => {
    const ctx = await ctxWithScript()
    vi.mocked(alignTranscript).mockResolvedValue([
      { word: 'hello', startMs: 120, endMs: 340 },
      { word: 'world', startMs: 350, endMs: 600 },
    ])

    await captionsStage.run(ctx)

    const artifact = JSON.parse(
      await fs.readFile(ctx.artifactPath('captions', 'words.json'), 'utf8'),
    )
    expect(artifact).toEqual({
      words: [
        { word: 'hello', startMs: 120, endMs: 340 },
        { word: 'world', startMs: 350, endMs: 600 },
      ],
    })
    for (const w of artifact.words) {
      expect(Number.isInteger(w.startMs)).toBe(true)
      expect(Number.isInteger(w.endMs)).toBe(true)
    }
    expect(vi.mocked(alignTranscript)).toHaveBeenCalledWith(
      expect.objectContaining({ transcript: 'Hook here\n\nOne.\n\nTwo.' }),
    )
  })

  it('throws when the aligner returns no words', async () => {
    const ctx = await ctxWithScript()
    vi.mocked(alignTranscript).mockResolvedValue([])
    await expect(captionsStage.run(ctx)).rejects.toThrow(/no word timings/)
  })

  it('copies provider timings from voice/timings.json and never calls whisperx', async () => {
    const ctx = await ctxWithScript()
    const words = [
      { word: 'Hook', startMs: 0, endMs: 180 },
      { word: 'here', startMs: 190, endMs: 350 },
    ]
    await fs.writeFile(ctx.artifactPath('voice', 'timings.json'), JSON.stringify({ words }))
    // Armed to prove it is NOT used.
    vi.mocked(alignTranscript).mockResolvedValue([{ word: 'whisper', startMs: 0, endMs: 100 }])

    await captionsStage.run(ctx)

    const artifact = JSON.parse(
      await fs.readFile(ctx.artifactPath('captions', 'words.json'), 'utf8'),
    )
    expect(artifact).toEqual({ words })
    expect(vi.mocked(alignTranscript)).not.toHaveBeenCalled()
  })

  it('falls through to whisperx when timings.json exists but has no words', async () => {
    const ctx = await ctxWithScript()
    await fs.writeFile(ctx.artifactPath('voice', 'timings.json'), JSON.stringify({ words: [] }))
    vi.mocked(alignTranscript).mockResolvedValue([{ word: 'whisper', startMs: 0, endMs: 100 }])

    await captionsStage.run(ctx)

    const artifact = JSON.parse(
      await fs.readFile(ctx.artifactPath('captions', 'words.json'), 'utf8'),
    )
    expect(artifact).toEqual({ words: [{ word: 'whisper', startMs: 0, endMs: 100 }] })
    expect(vi.mocked(alignTranscript)).toHaveBeenCalledTimes(1)
  })
})
