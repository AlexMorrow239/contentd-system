import { promises as fs } from 'node:fs'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../../../infra/providers/whisperx.js', () => ({ alignTranscript: vi.fn() }))

import { makeCtx, writeScriptJson } from '../../../../../testing/job.js'
import { alignTranscript } from '../../../../infra/providers/whisperx.js'
import { classify, errorMessage } from '../../../../shared/errors.js'
import type { JobContext } from '../../contracts.js'
import { captionsStage } from '../captions.js'

// testScript()'s hook/segments are 'Hook here' / 'One.' / 'Two.' — the exact
// three lines the transcript assertion below joins.
function ctxWithScript(): JobContext {
  return writeScriptJson(makeCtx())
}

beforeEach(() => vi.clearAllMocks())

describe('captionsStage', () => {
  it('writes words.json with integer-ms timings from the aligner', async () => {
    const ctx = ctxWithScript()
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

  it('throws when the aligner returns no words, classified as provider/invalid', async () => {
    const ctx = ctxWithScript()
    vi.mocked(alignTranscript).mockResolvedValue([])
    const err = await captionsStage.run(ctx).catch((e: unknown) => e)
    expect(errorMessage(err)).toMatch(/no word timings/)
    expect(classify(err)).toMatchObject({ domain: 'provider', kind: 'invalid' })
  })

  it('copies provider timings from voice/timings.json and never calls whisperx', async () => {
    const ctx = ctxWithScript()
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
    const ctx = ctxWithScript()
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
