import React from 'react'
import { Composition } from 'remotion'
import { ShortVideo, type ShortVideoProps } from './ShortVideo'
import { CAPTION_STYLE, VIDEO_WIDTH, VIDEO_HEIGHT } from '../../src/remotion-types'

const FPS = 30

const defaultProps: ShortVideoProps = {
  audioSrc: '',
  backgroundSrc: '',
  words: [],
  style: CAPTION_STYLE,
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
