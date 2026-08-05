import { readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { execa } from 'execa'
import { probe } from '../media/ffmpeg.js'
import type { JobContext, StageDef } from '../jobs/types.js'
import { VIDEO_WIDTH, VIDEO_HEIGHT } from '../remotion-types.js'
import type { ScriptArtifact } from './script.js'
import type { VoiceMeta } from './voice.js'
import { narrationWordCount, minPlausibleNarrationMs } from './narration-text.js'

export interface QcResult {
  passed: boolean
  checks: { name: string; passed: boolean; detail: string }[]
}

/**
 * Reads this stage's artifact out of a run directory. Exported so the runner's
 * final gate does not have to know qc's own file layout — every stage owns the
 * name and shape of what it writes. Missing or corrupt is thrown, not
 * tolerated: a job that reached the gate has a `done` qc stage, so an
 * unreadable qc.json is a real failure and not a legacy shape.
 */
export function readQcResult(runDir: string): QcResult {
  return JSON.parse(readFileSync(join(runDir, 'qc', 'qc.json'), 'utf8')) as QcResult
}

// Audio level, black runs and freezes all come from ONE decode of the finished
// video: the audio filter and the chained video filter write their markers into
// the same stderr, and the three parsers below are independent scans over it.
// Three separate `-f null -` invocations decoded a 15-180s 1080x1920 short three
// times over for the same numbers. probe() stays its own cheap ffprobe call.
const ANALYSIS_VF = 'blackdetect=d=1.0:pix_th=0.10,freezedetect=n=-60dB:d=2'

const MB = 1024 * 1024
const MAX_SIZE_BYTES = 256 * MB

// Artifact reads that tolerate absence. For the optional ones (captions,
// script) a missing or unreadable file is a failed check rather than a crash;
// voice.json is required and its caller turns `undefined` into a throw.
function readJson<T>(path: string): T | undefined {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T
  } catch {
    return undefined
  }
}

function longestBlackRunSeconds(stderr: string): number {
  // blackdetect logs: [blackdetect @ 0x..] black_start:1.0 black_end:2.5 black_duration:1.5
  let max = 0
  const re = /black_duration:([0-9.]+)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(stderr)) !== null) {
    const d = parseFloat(m[1])
    if (d > max) max = d
  }
  return max
}

function parseMeanVolumeDb(stderr: string): number {
  // volumedetect logs: [Parsed_volumedetect_0 @ 0x..] mean_volume: -21.4 dB
  const m = /mean_volume:\s*(-?[0-9.]+) dB/.exec(stderr)
  return m ? parseFloat(m[1]) : NaN
}

function longestFreezeMs(stderr: string, videoDurationMs: number): number {
  // freezedetect logs lavfi.freezedetect.freeze_start / .freeze_duration / .freeze_end
  let max = 0
  const durRe = /freeze_duration[^0-9-]*([0-9.]+)/g
  let m: RegExpExecArray | null
  while ((m = durRe.exec(stderr)) !== null) {
    const ms = Math.round(parseFloat(m[1]) * 1000)
    if (ms > max) max = ms
  }
  if (max > 0) return max
  // A freeze that runs to EOF is reported by freeze_start only (no duration/end);
  // measure it to the end of the clip so an open-ended freeze is not ignored.
  const startRe = /freeze_start[^0-9-]*([0-9.]+)/g
  while ((m = startRe.exec(stderr)) !== null) {
    const ms = videoDurationMs - Math.round(parseFloat(m[1]) * 1000)
    if (ms > max) max = ms
  }
  return max
}

export function qcStage(opts?: { minMs?: number; maxMs?: number }): StageDef {
  const minMs = opts?.minMs ?? 15000
  const maxMs = opts?.maxMs ?? 180000
  return {
    name: 'qc',
    async run(ctx: JobContext): Promise<void> {
      const finalPath = ctx.artifactPath('assemble', 'final.mp4')
      const voice = readJson<VoiceMeta>(ctx.artifactPath('voice', 'voice.json'))
      if (voice === undefined) {
        throw new Error(`qc: unreadable voice artifact ${ctx.artifactPath('voice', 'voice.json')}`)
      }
      const p = await probe(finalPath)
      const checks: QcResult['checks'] = []

      checks.push({
        name: 'duration-bounds',
        passed: p.durationMs >= minMs && p.durationMs <= maxMs && p.durationMs >= voice.durationMs,
        detail: `duration ${p.durationMs}ms; bounds [${minMs},${maxMs}]; voice ${voice.durationMs}ms`,
      })
      checks.push({
        name: 'resolution',
        passed: p.width === VIDEO_WIDTH && p.height === VIDEO_HEIGHT,
        detail: `${p.width}x${p.height}`,
      })
      checks.push({
        name: 'has-audio',
        passed: p.hasAudio,
        detail: p.hasAudio ? 'audio stream present' : 'no audio stream',
      })

      const { stderr: analysis } = await execa(
        'ffmpeg',
        ['-i', finalPath, '-af', 'volumedetect', '-vf', ANALYSIS_VF, '-f', 'null', '-'],
        { reject: false },
      )

      const meanDb = parseMeanVolumeDb(analysis)
      checks.push({
        name: 'audio-level',
        passed: Number.isFinite(meanDb) && meanDb >= -50,
        detail: Number.isFinite(meanDb) ? `mean_volume ${meanDb} dB` : 'mean_volume unparsable',
      })

      checks.push({
        name: 'fps',
        passed: p.fps >= 29 && p.fps <= 31,
        detail: `fps ${p.fps}`,
      })

      const captions = readJson<{ words: unknown[] }>(ctx.artifactPath('captions', 'words.json'))
      const wordCount = Array.isArray(captions?.words) ? captions.words.length : 0
      checks.push({
        name: 'captions-present',
        passed: wordCount > 0,
        detail: `${wordCount} words`,
      })

      // A TTS backend that silently truncates still emits a valid WAV, so the gate
      // re-checks the voice track against the script it was meant to narrate. Same
      // rule as the voice-stage guard, applied here so an old or partially
      // regenerated artifact set cannot slip through.
      const script = readJson<ScriptArtifact>(ctx.artifactPath('script', 'script.json'))
      const narrationWords = script ? narrationWordCount(script) : 0
      const minNarrationMs = minPlausibleNarrationMs(narrationWords)
      checks.push({
        name: 'narration-complete',
        passed: voice.durationMs >= minNarrationMs,
        detail: `${narrationWords} words; voice ${voice.durationMs}ms; minimum ${minNarrationMs}ms`,
      })

      const maxBlack = longestBlackRunSeconds(analysis)
      checks.push({
        name: 'black-frames',
        passed: maxBlack < 1.0,
        detail: `longest black run ${maxBlack.toFixed(2)}s`,
      })

      const maxFreezeMs = longestFreezeMs(analysis, p.durationMs)
      checks.push({
        name: 'frozen-frames',
        passed: maxFreezeMs < 2000,
        detail: `longest freeze ${maxFreezeMs}ms`,
      })

      const bytes = statSync(finalPath).size
      checks.push({
        name: 'file-size',
        passed: bytes < MAX_SIZE_BYTES,
        detail: `${(bytes / MB).toFixed(2)} MB`,
      })

      const result: QcResult = { passed: checks.every((c) => c.passed), checks }
      writeFileSync(ctx.artifactPath('qc', 'qc.json'), JSON.stringify(result, null, 2))
      ctx.log.info({ passed: result.passed }, 'qc: complete')
    },
  }
}
