import type { WordTiming } from './providers/whisperx.js'

export interface CaptionStyle {
  font: string
  fontSizePx: number
  activeColor: string
  inactiveColor: string
  strokePx: number
}

// Shared by production renders and the Remotion preview, independent of channel config.
export const CAPTION_STYLE: Readonly<CaptionStyle> = Object.freeze({
  font: 'Inter',
  fontSizePx: 72,
  activeColor: '#FFD700',
  inactiveColor: '#FFFFFF',
  strokePx: 8,
})

// The 9:16 output contract lives in a module imported from both src and
// integrations/remotion. The Remotion composition, the crop/scale filter, the
// visuals fast path and qc's dimension check are the same number four times
// over and must move together.
export const VIDEO_WIDTH = 1080
export const VIDEO_HEIGHT = 1920

export type ShortVideoProps = {
  audioSrc: string
  backgroundSrc: string
  words: WordTiming[]
  style: CaptionStyle
  durationMs: number
}
