import type { CaptionStyle } from './config/channel.js'
import type { WordTiming } from './providers/whisperx.js'

export type ShortVideoProps = {
  audioSrc: string
  backgroundSrc: string
  bgmSrc?: string
  bgmVolume?: number // default 0.12
  words: WordTiming[]
  style: CaptionStyle
  durationMs: number
}
