import type { CaptionStyle } from './config/channel.js'
import type { WordTiming } from './providers/whisperx.js'

// The 9:16 output contract, in the module both sides of the src/remotion
// boundary already import. The Remotion composition, the crop/scale filter,
// the visuals fast path and qc's dimension check are the same number four
// times over and must move together.
export const VIDEO_WIDTH = 1080
export const VIDEO_HEIGHT = 1920

export type ShortVideoProps = {
  audioSrc: string
  backgroundSrc: string
  bgmSrc?: string
  bgmVolume?: number // default 0.12
  words: WordTiming[]
  style: CaptionStyle
  durationMs: number
}
