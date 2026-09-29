import React from 'react'
import { useCurrentFrame, useVideoConfig } from 'remotion'
import type { CaptionStyle } from '../../daemon/src/remotion-types'
import type { WordTiming } from '../../daemon/src/providers/whisperx'

// How many words share one on-screen caption page.
export const WORDS_PER_PAGE = 4

export function chunkWords(words: WordTiming[], size: number): WordTiming[][] {
  const pages: WordTiming[][] = []
  for (let i = 0; i < words.length; i += size) pages.push(words.slice(i, i + size))
  return pages
}

// `em` in a flex container's `gap` resolves against that CONTAINER's own
// font-size, not the word spans' fontSizePx -- with no font-size set on the
// container itself that's the browser default (16px), so a "0.25em" gap
// rendered as a near-invisible 4px regardless of caption size. Compute the
// gap directly off the caption's own fontSizePx instead.
export function captionWordGapPx(fontSizePx: number): number {
  return Math.round(fontSizePx * 0.25)
}

export const Captions: React.FC<{ words: WordTiming[]; style: CaptionStyle }> = ({
  words,
  style,
}) => {
  const frame = useCurrentFrame()
  const { fps } = useVideoConfig()
  const currentTimeMs = (frame / fps) * 1000

  // Memoized on `words`: the paging is identical for every frame of a render,
  // and rebuilding it in the component body re-sliced the whole word list on
  // each of a short's ~1800 frames.
  const pages = React.useMemo(() => chunkWords(words, WORDS_PER_PAGE), [words])
  const page = pages.find(
    (p) => currentTimeMs >= p[0].startMs && currentTimeMs <= p[p.length - 1].endMs,
  )
  if (!page) return null

  return (
    <div
      style={{
        position: 'absolute',
        bottom: '25%',
        left: 0,
        right: 0,
        display: 'flex',
        flexWrap: 'wrap',
        justifyContent: 'center',
        alignItems: 'center',
        gap: `${captionWordGapPx(style.fontSizePx)}px`,
        padding: '0 5%',
        textAlign: 'center',
      }}
    >
      {page.map((w, i) => {
        const active = currentTimeMs >= w.startMs && currentTimeMs <= w.endMs
        return (
          <span
            key={i}
            style={{
              fontFamily: style.font,
              fontWeight: 'bold',
              fontSize: style.fontSizePx,
              color: active ? style.activeColor : style.inactiveColor,
              WebkitTextStroke: `${style.strokePx}px black`,
              paintOrder: 'stroke fill',
              transform: active ? 'scale(1.08)' : 'scale(1)',
              display: 'inline-block',
            }}
          >
            {w.word}
          </span>
        )
      })}
    </div>
  )
}
