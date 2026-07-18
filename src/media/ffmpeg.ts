import { execa } from 'execa'

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

export async function probe(file: string): Promise<MediaProbe> {
  const { stdout } = await execa('ffprobe', [
    '-v', 'error',
    '-print_format', 'json',
    '-show_streams',
    '-show_format',
    file,
  ])
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

export async function cropToVertical(input: string, output: string): Promise<void> {
  await execa('ffmpeg', [
    '-i', input,
    '-vf', 'scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920',
    '-c:a', 'copy',
    '-y',
    output,
  ])
}

export async function loopToDuration(input: string, output: string, durationMs: number): Promise<void> {
  const seconds = (durationMs / 1000).toFixed(3)
  await execa('ffmpeg', [
    '-stream_loop', '-1',
    '-i', input,
    '-t', seconds,
    '-c:v', 'libx264',
    '-pix_fmt', 'yuv420p',
    '-an',
    '-y',
    output,
  ])
}
