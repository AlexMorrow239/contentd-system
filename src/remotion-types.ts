import type { CaptionStyle } from './config/channel.js'
import type { WordTiming } from './providers/whisperx.js'

// One premium scene clip on the assembled timeline. src is a public-relative
// path (resolved via staticFile in the composition), durationMs the scene
// window length on the timeline, playbackRate the fitClipToWindow result
// (1 = play-and-trim, < 1 = slowed to cover a window longer than the clip).
export type SceneClip = { src: string; durationMs: number; playbackRate: number }

export type ShortVideoProps = {
  audioSrc: string
  backgroundSrc?: string // volume: single looped background (exactly one of these two is set)
  sceneClips?: SceneClip[] // premium: sequenced clips
  bgmSrc?: string
  bgmVolume?: number // default 0.12
  words: WordTiming[]
  style: CaptionStyle
  durationMs: number
}
