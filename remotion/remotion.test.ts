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
  it('bundles and resolves 1080x1920@30 metadata', async () => {
    const serveUrl = await bundle({ entryPoint: path.resolve('remotion/index.ts') })

    const props: ShortVideoProps = {
      audioSrc: 'sample/narration.wav',
      backgroundSrc: 'sample/background.mp4',
      words: [{ word: 'hello', startMs: 0, endMs: 500 }],
      style,
      durationMs: 4000,
    }
    const comp = await selectComposition({
      serveUrl,
      id: 'ShortVideo',
      inputProps: props,
    })
    expect(comp.width).toBe(1080)
    expect(comp.height).toBe(1920)
    expect(comp.fps).toBe(30)
    expect(comp.durationInFrames).toBe(Math.ceil((4000 / 1000) * 30)) // 120
  }, 180000)
})
