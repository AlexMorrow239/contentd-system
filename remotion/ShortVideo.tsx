import React from 'react'
import { AbsoluteFill, Audio, OffthreadVideo, Series, staticFile } from 'remotion'
import type { ShortVideoProps } from '../src/remotion-types'
import { Captions } from './Captions'
import { cumulativeSceneFrames } from './frames'

// Single source of truth is src/remotion-types.ts; re-exported here so Root.tsx and
// the composition test can keep importing ShortVideoProps from './ShortVideo'.
export type { ShortVideoProps }

const FPS = 30

// audioSrc/backgroundSrc/bgmSrc/sceneClips[].src are public-relative paths (files
// copied into the bundle's public/ folder by the assemble stage) resolved here via
// staticFile().
//
// Exactly one visual variant must be provided: backgroundSrc (volume tier: one
// looped background) or sceneClips (premium tier: Series-sequenced clips, each
// durationInFrames = round(durationMs / 1000 * 30), muted — narration owns the
// audio track). The guard is truthiness-based (non-empty string / non-empty
// array) because Remotion shallow-merges defaultProps into inputProps: Root.tsx's
// defaultProps carry backgroundSrc '', which must not count as "set" when a
// premium render passes only sceneClips.
export const ShortVideo: React.FC<ShortVideoProps> = ({
  audioSrc,
  backgroundSrc,
  sceneClips,
  bgmSrc,
  bgmVolume,
  words,
  style,
}) => {
  const background = backgroundSrc || undefined
  const scenes = sceneClips && sceneClips.length > 0 ? sceneClips : undefined
  if ((background === undefined) === (scenes === undefined)) {
    throw new Error('ShortVideo: exactly one of backgroundSrc or sceneClips must be set')
  }
  // Cumulative rounding so the per-scene frame counts sum to the full timeline
  // length (see frames.ts) instead of drifting a few frames short over many
  // scenes and leaving a black flash at the tail.
  const sceneFrames = scenes ? cumulativeSceneFrames(scenes.map((c) => c.durationMs), FPS) : []
  return (
    <AbsoluteFill style={{ backgroundColor: 'black' }}>
      {scenes ? (
        <Series>
          {scenes.map((clip, i) => (
            <Series.Sequence key={clip.src} durationInFrames={sceneFrames[i]}>
              <OffthreadVideo
                src={staticFile(clip.src)}
                playbackRate={clip.playbackRate}
                muted
              />
            </Series.Sequence>
          ))}
        </Series>
      ) : background ? (
        <OffthreadVideo src={staticFile(background)} muted />
      ) : null}
      <Audio src={staticFile(audioSrc)} />
      {bgmSrc ? <Audio src={staticFile(bgmSrc)} volume={bgmVolume ?? 0.12} /> : null}
      <Captions words={words} style={style} />
    </AbsoluteFill>
  )
}
