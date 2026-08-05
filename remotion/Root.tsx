import React from 'react'
import { Composition } from 'remotion'
import { ShortVideo, type ShortVideoProps } from './ShortVideo'
import { VIDEO_WIDTH, VIDEO_HEIGHT } from '../src/remotion-types'

const FPS = 30

const defaultProps: ShortVideoProps = {
  audioSrc: '',
  backgroundSrc: '',
  words: [],
  style: {
    font: 'Inter',
    fontSizePx: 72,
    activeColor: '#FFD700',
    inactiveColor: '#FFFFFF',
    strokePx: 8,
  },
  durationMs: 1000,
}

export const RemotionRoot: React.FC = () => {
  return (
    <Composition
      id="ShortVideo"
      component={ShortVideo}
      width={VIDEO_WIDTH}
      height={VIDEO_HEIGHT}
      fps={FPS}
      durationInFrames={FPS} // placeholder; calculateMetadata overrides it
      defaultProps={defaultProps}
      calculateMetadata={({ props }) => ({
        durationInFrames: Math.ceil((props.durationMs / 1000) * FPS),
      })}
    />
  )
}
