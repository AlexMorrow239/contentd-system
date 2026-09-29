import { execa } from 'execa'
import { VIDEO_WIDTH, VIDEO_HEIGHT } from '../remotion-types.js'

// The one 9:16 scale+crop filter every path here shares, derived from the same
// constants the Remotion composition is built at.
const VERTICAL_FILTER = `scale=${VIDEO_WIDTH}:${VIDEO_HEIGHT}:force_original_aspect_ratio=increase,crop=${VIDEO_WIDTH}:${VIDEO_HEIGHT}`

export interface MediaProbe {
  durationMs: number
  width: number
  height: number
  hasAudio: boolean
  fps: number
}

interface FfprobeStream {
  codec_type: string
  width?: number
  height?: number
  r_frame_rate?: string
}
interface FfprobeJson {
  streams: FfprobeStream[]
  format: { duration?: string }
}

export async function probe(file: string, signal?: AbortSignal): Promise<MediaProbe> {
  signal?.throwIfAborted()
  const { stdout } = await execa(
    'ffprobe',
    ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', file],
    { cancelSignal: signal },
  )
  const data = JSON.parse(stdout) as FfprobeJson
  const video = data.streams.find((s) => s.codec_type === 'video')
  if (!video) throw new Error(`probe: no video stream in ${file}`)
  const hasAudio = data.streams.some((s) => s.codec_type === 'audio')
  const durationSec = parseFloat(data.format.duration ?? '0')
  const [num, den] = (video.r_frame_rate ?? '0/1').split('/').map(Number)
  const fps = den ? num / den : 0
  return {
    durationMs: Math.round(durationSec * 1000),
    width: video.width ?? 0,
    height: video.height ?? 0,
    hasAudio,
    fps,
  }
}

export async function cropToVertical(
  input: string,
  output: string,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted()
  await execa('ffmpeg', ['-i', input, '-vf', VERTICAL_FILTER, '-c:a', 'copy', '-y', output], {
    cancelSignal: signal,
  })
}

export async function loopToDuration(
  input: string,
  output: string,
  durationMs: number,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted()
  await execa('ffmpeg', loopArgs(input, output, durationMs), { cancelSignal: signal })
}

/**
 * Loop, trim and crop in ONE encode. Cropping first and looping second means
 * re-encoding the whole source at 1080x1920 only to keep the first `durationMs`
 * of it — a multi-minute stock clip backing a 45s narration pays for the whole
 * clip. Fusing the filter into the looping encode pays for the output length
 * only, and needs no intermediate file.
 */
export async function cropAndLoopToDuration(
  input: string,
  output: string,
  durationMs: number,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted()
  await execa('ffmpeg', loopArgs(input, output, durationMs, VERTICAL_FILTER), {
    cancelSignal: signal,
  })
}

function loopArgs(input: string, output: string, durationMs: number, filter?: string): string[] {
  return [
    '-stream_loop',
    '-1',
    '-i',
    input,
    '-t',
    (durationMs / 1000).toFixed(3),
    ...(filter ? ['-vf', filter] : []),
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    '-an',
    '-y',
    output,
  ]
}
