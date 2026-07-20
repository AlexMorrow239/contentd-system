import { readFileSync, statSync, writeFileSync } from 'node:fs'
import { execa } from 'execa'
import { probe } from '../media/ffmpeg.js'
import type { JobContext, StageDef } from '../jobs/types.js'
import type { ScriptOutput } from './script.js'
import { narrationText } from './narration-text.js'
import { MAX_PLAUSIBLE_WORDS_PER_SEC } from './voice.js'

export interface QcResult {
  passed: boolean
  checks: { name: string; passed: boolean; detail: string }[]
}

const MB = 1024 * 1024
const MAX_SIZE_BYTES = 256 * MB

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
      const voice = JSON.parse(
        readFileSync(ctx.artifactPath('voice', 'voice.json'), 'utf8'),
      ) as { durationMs: number }
      const p = await probe(finalPath)
      const checks: QcResult['checks'] = []

      checks.push({
        name: 'duration-bounds',
        passed: p.durationMs >= minMs && p.durationMs <= maxMs && p.durationMs >= voice.durationMs,
        detail: `duration ${p.durationMs}ms; bounds [${minMs},${maxMs}]; voice ${voice.durationMs}ms`,
      })
      checks.push({
        name: 'resolution',
        passed: p.width === 1080 && p.height === 1920,
        detail: `${p.width}x${p.height}`,
      })
      checks.push({
        name: 'has-audio',
        passed: p.hasAudio,
        detail: p.hasAudio ? 'audio stream present' : 'no audio stream',
      })

      const { stderr: volStderr } = await execa(
        'ffmpeg',
        ['-i', finalPath, '-af', 'volumedetect', '-vn', '-f', 'null', '-'],
        { reject: false },
      )
      const meanDb = parseMeanVolumeDb(volStderr)
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

      let wordCount = 0
      try {
        const captions = JSON.parse(
          readFileSync(ctx.artifactPath('captions', 'words.json'), 'utf8'),
        ) as { words: unknown[] }
        wordCount = Array.isArray(captions.words) ? captions.words.length : 0
      } catch {
        wordCount = 0
      }
      checks.push({
        name: 'captions-present',
        passed: wordCount > 0,
        detail: `${wordCount} words`,
      })

      // A TTS backend that silently truncates still emits a valid WAV, so the gate
      // re-checks the voice track against the script it was meant to narrate. Same
      // rule as the voice-stage guard, applied here so an old or partially
      // regenerated artifact set cannot slip through.
      let narrationWords = 0
      try {
        const script = JSON.parse(
          readFileSync(ctx.artifactPath('script', 'script.json'), 'utf8'),
        ) as ScriptOutput
        narrationWords = narrationText(script).trim().split(/\s+/).filter(Boolean).length
      } catch {
        narrationWords = 0
      }
      const minNarrationMs = Math.round(narrationWords * (1000 / MAX_PLAUSIBLE_WORDS_PER_SEC))
      checks.push({
        name: 'narration-complete',
        passed: voice.durationMs >= minNarrationMs,
        detail: `${narrationWords} words; voice ${voice.durationMs}ms; minimum ${minNarrationMs}ms`,
      })

      const { stderr } = await execa(
        'ffmpeg',
        ['-i', finalPath, '-vf', 'blackdetect=d=1.0:pix_th=0.10', '-an', '-f', 'null', '-'],
        { reject: false },
      )
      const maxBlack = longestBlackRunSeconds(stderr)
      checks.push({
        name: 'black-frames',
        passed: maxBlack < 1.0,
        detail: `longest black run ${maxBlack.toFixed(2)}s`,
      })

      const { stderr: freezeStderr } = await execa(
        'ffmpeg',
        ['-i', finalPath, '-vf', 'freezedetect=n=-60dB:d=2', '-an', '-f', 'null', '-'],
        { reject: false },
      )
      const maxFreezeMs = longestFreezeMs(freezeStderr, p.durationMs)
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
