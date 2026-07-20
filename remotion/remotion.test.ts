import { describe, expect, it } from 'vitest'
import { bundle } from '@remotion/bundler'
import { selectComposition } from '@remotion/renderer'
import path from 'node:path'
import type { ShortVideoProps } from './ShortVideo'

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
