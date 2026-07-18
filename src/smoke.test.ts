import { describe, expect, it } from 'vitest'
import { join } from 'node:path'

describe('smoke', () => {
  it('runs under the ESM + TypeScript + vitest toolchain', () => {
    const canvas: { width: number; height: number; fps: number } = {
      width: 1080,
      height: 1920,
      fps: 30,
    }
    expect(join('runs', 'abc', 'script')).toBe('runs/abc/script')
    expect(canvas.width).toBe(1080)
    expect(canvas.height).toBe(1920)
    expect(canvas.fps).toBe(30)
  })
})
