import { Audio, Video } from '@remotion/media'
import React from 'react'
import { AbsoluteFill, staticFile } from 'remotion'
import type { ShortVideoProps } from '../../daemon/src/shared/contracts/video'
import { Captions } from './Captions'

// Single source of truth is daemon/src/shared/contracts/video.ts; re-exported here so Root.tsx and
// the composition test can keep importing ShortVideoProps from './ShortVideo'.
export type { ShortVideoProps }

// audioSrc/backgroundSrc are public-relative paths (files copied into the
// bundle's public/ folder by the assemble stage) resolved here via staticFile().
export const ShortVideo: React.FC<ShortVideoProps> = ({
  audioSrc,
  backgroundSrc,
  words,
  style,
}) => {
  return (
    <AbsoluteFill style={{ backgroundColor: 'black' }}>
      <Video src={staticFile(backgroundSrc)} muted />
      <Audio src={staticFile(audioSrc)} />
      <Captions words={words} style={style} />
    </AbsoluteFill>
  )
}
