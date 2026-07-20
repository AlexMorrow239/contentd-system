import { describe, expect, it } from 'vitest'
import { bundle } from '@remotion/bundler'
import { selectComposition } from '@remotion/renderer'
import path from 'node:path'
import type { ShortVideoProps } from './ShortVideo'
import { cumulativeSceneFrames } from './frames'

const style = {
  font: 'Inter',
  fontSizePx: 72,
  activeColor: '#FFD700',
  inactiveColor: '#FFFFFF',
  strokePx: 8,
}

describe('ShortVideo composition', () => {
  it('bundles once and resolves 1080x1920@30 metadata for both prop variants', async () => {
    const serveUrl = await bundle({ entryPoint: path.resolve('remotion/index.ts') })

    // Volume variant: single looped background.
    const volumeProps: ShortVideoProps = {
      audioSrc: 'sample/narration.wav',
      backgroundSrc: 'sample/background.mp4',
      words: [{ word: 'hello', startMs: 0, endMs: 500 }],
      style,
      durationMs: 4000,
    }
    const volumeComp = await selectComposition({
      serveUrl,
      id: 'ShortVideo',
      inputProps: volumeProps,
    })
    expect(volumeComp.width).toBe(1080)
    expect(volumeComp.height).toBe(1920)
    expect(volumeComp.fps).toBe(30)
    expect(volumeComp.durationInFrames).toBe(Math.ceil((4000 / 1000) * 30)) // 120

    // Premium variant: sequenced scene clips; composition duration still
    // derives from durationMs (the narration length), never the clip list.
    const premiumProps: ShortVideoProps = {
      audioSrc: 'sample/narration.wav',
      sceneClips: [
        { src: 'sample/scene-01.mp4', durationMs: 2500, playbackRate: 1 },
        { src: 'sample/scene-02.mp4', durationMs: 2500, playbackRate: 0.8 },
      ],
      words: [{ word: 'hello', startMs: 0, endMs: 500 }],
      style,
      durationMs: 5000,
    }
    const premiumComp = await selectComposition({
      serveUrl,
      id: 'ShortVideo',
      inputProps: premiumProps,
    })
    expect(premiumComp.width).toBe(1080)
    expect(premiumComp.height).toBe(1920)
    expect(premiumComp.fps).toBe(30)
    expect(premiumComp.durationInFrames).toBe(Math.ceil((5000 / 1000) * 30)) // 150
  }, 180000)
})

describe('cumulativeSceneFrames', () => {
  it('sums to round(totalMs * fps / 1000) even when per-scene rounding would drift', () => {
    // Six scenes whose independent Math.round would each drift ~+0.5 frame,
    // dropping ~3 frames over the video (a tail black flash). Cumulative rounding
    // keeps the sum exact.
    const durations = Array.from({ length: 6 }, () => 1016.7)
    const totalMs = durations.reduce((a, b) => a + b, 0)
    const frames = cumulativeSceneFrames(durations, 30)
    const sum = frames.reduce((a, b) => a + b, 0)

    expect(sum).toBe(Math.round((totalMs * 30) / 1000))
    for (const f of frames) expect(f).toBeGreaterThanOrEqual(1) // every Series.Sequence needs >= 1 frame

    // Prove the fixture actually exercises the drift the old approach suffered:
    // independent per-scene rounding does NOT reach the same total.
    const independent = durations.reduce((a, d) => a + Math.round((d * 30) / 1000), 0)
    expect(independent).not.toBe(sum)
    expect(Math.abs(independent - sum)).toBeGreaterThanOrEqual(1)
  })
})
