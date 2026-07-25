import { describe, it, expect } from 'vitest'
import { captionWordGapPx } from './Captions'

describe('captionWordGapPx', () => {
  it('scales with the caption font size instead of the inherited document font size', () => {
    // Captions.tsx used to set the flex container's `gap` as `0.25em`, which
    // CSS resolves against the CONTAINER's own font-size (default 16px, since
    // only the word spans set fontSizePx) -- a 4px gap regardless of how big
    // the captions actually render, invisible once WebkitTextStroke bleeds
    // into it. The gap must scale off the caption's own fontSizePx.
    expect(captionWordGapPx(72)).toBe(18)
  })

  it('scales proportionally for other font sizes', () => {
    expect(captionWordGapPx(40)).toBe(10)
  })
})
