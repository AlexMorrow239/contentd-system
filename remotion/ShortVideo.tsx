import React from 'react'
import { AbsoluteFill, Audio, OffthreadVideo, staticFile } from 'remotion'
import type { ShortVideoProps } from '../src/remotion-types'
import { Captions } from './Captions'

// Single source of truth is src/remotion-types.ts; re-exported here so Root.tsx and
// the composition test can keep importing ShortVideoProps from './ShortVideo'.
export type { ShortVideoProps }

// Background music sits well under the narration; nothing configures it per
// channel, so it is a named constant rather than a prop no caller ever passed.
const BGM_VOLUME = 0.12

// audioSrc/backgroundSrc/bgmSrc are public-relative paths (files copied into the
// bundle's public/ folder by the assemble stage) resolved here via staticFile().
export const ShortVideo: React.FC<ShortVideoProps> = ({
  audioSrc,
  backgroundSrc,
  bgmSrc,
  words,
  style,
}) => {
  return (
    <AbsoluteFill style={{ backgroundColor: 'black' }}>
      <OffthreadVideo src={staticFile(backgroundSrc)} muted />
      <Audio src={staticFile(audioSrc)} />
      {bgmSrc ? <Audio src={staticFile(bgmSrc)} volume={BGM_VOLUME} /> : null}
      <Captions words={words} style={style} />
    </AbsoluteFill>
  )
}
