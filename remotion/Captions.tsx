import React from 'react'
import { useCurrentFrame, useVideoConfig } from 'remotion'
import type { CaptionStyle } from '../src/config/channel'
import type { WordTiming } from '../src/providers/whisperx'

export function chunkWords(words: WordTiming[], size = 4): WordTiming[][] {
  const pages: WordTiming[][] = []
  for (let i = 0; i < words.length; i += size) pages.push(words.slice(i, i + size))
  return pages
}

export const Captions: React.FC<{ words: WordTiming[]; style: CaptionStyle }> = ({ words, style }) => {
  const frame = useCurrentFrame()
  const { fps } = useVideoConfig()
  const currentTimeMs = (frame / fps) * 1000

  const pages = chunkWords(words, 4)
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
        gap: '0.25em',
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
