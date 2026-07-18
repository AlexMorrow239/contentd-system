import React from 'react'
import { Composition } from 'remotion'
import { ShortVideo, type ShortVideoProps } from './ShortVideo'

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
      width={1080}
      height={1920}
      fps={FPS}
      durationInFrames={FPS} // placeholder; calculateMetadata overrides it
      defaultProps={defaultProps}
      calculateMetadata={({ props }) => ({
        durationInFrames: Math.ceil((props.durationMs / 1000) * FPS),
      })}
    />
  )
}
