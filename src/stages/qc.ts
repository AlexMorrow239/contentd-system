import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { execa } from 'execa'
import { z } from 'zod'
import type Anthropic from '@anthropic-ai/sdk'
import { probe } from '../media/ffmpeg.js'
import { assertBudget, recordCost } from '../jobs/costs.js'
import { visionJudgment } from '../providers/anthropic.js'
import { errorCostUsdMicros } from '../providers/errors.js'
import type { JobContext, StageDef } from '../jobs/types.js'
import { isScenesOutput, type ScriptArtifact } from './script.js'
import type { ScenesManifest } from './visuals-premium.js'
import { narrationWordCount, minPlausibleNarrationMs } from './narration-text.js'

export interface QcResult {
  passed: boolean
  checks: { name: string; passed: boolean; detail: string }[]
}

type QcCheck = QcResult['checks'][number]

const MB = 1024 * 1024
const MAX_SIZE_BYTES = 256 * MB

// Scene-coverage sanity bounds: fal clips are generated at native 5s or 10s, so
// anything under 3s or over 15s is a truncated or corrupt encode. The 50ms end
// tolerance absorbs word-timing rounding; window starts/joins are exact by the
// scene-windows contract (integer ms, exact tiling).
const MIN_CLIP_MS = 3000
const MAX_CLIP_MS = 15000
const COVERAGE_TOLERANCE_MS = 50

// Pre-flight budget reservation for the qc vision call: three PNG frames plus a
// short prompt against claude-sonnet-5 lands well under $0.015 at list price.
const ESTIMATED_VISION_COST_MICROS = 15_000

const SpotCheckSchema = z.object({ pass: z.boolean(), issues: z.array(z.string()) })

// Optional artifacts: a missing or unreadable one is a failed check, not a crash.
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

// Premium check (a): the scenes manifest must tile [0, voice.durationMs] with no
// gaps or overlaps, and every referenced clip must exist and probe sane. Free
// and deterministic; returns on the FIRST violation so the detail names it.
async function sceneCoverageCheck(ctx: JobContext, voiceDurationMs: number): Promise<QcCheck> {
  const name = 'scene-coverage'
  const manifest = readJson<ScenesManifest>(ctx.artifactPath('visuals', 'scenes.json'))
  if (!manifest || !Array.isArray(manifest.scenes) || manifest.scenes.length === 0) {
    return { name, passed: false, detail: 'visuals/scenes.json missing, unreadable, or has no scenes' }
  }
  const scenes = manifest.scenes
  if (scenes[0].startMs !== 0) {
    return { name, passed: false, detail: `scene 1 starts at ${scenes[0].startMs}ms; expected 0` }
  }
  for (let i = 0; i < scenes.length - 1; i++) {
    if (scenes[i].endMs !== scenes[i + 1].startMs) {
      return {
        name,
        passed: false,
        detail: `gap/overlap: scene ${i + 1} ends at ${scenes[i].endMs}ms but scene ${i + 2} starts at ${scenes[i + 1].startMs}ms`,
      }
    }
  }
  const lastEnd = scenes[scenes.length - 1].endMs
  if (Math.abs(lastEnd - voiceDurationMs) > COVERAGE_TOLERANCE_MS) {
    return {
      name,
      passed: false,
      detail: `last scene ends at ${lastEnd}ms but voice runs ${voiceDurationMs}ms (tolerance ${COVERAGE_TOLERANCE_MS}ms)`,
    }
  }
  for (const scene of scenes) {
    const clipPath = ctx.artifactPath('visuals', scene.clip)
    if (!existsSync(clipPath)) {
      return { name, passed: false, detail: `clip missing: ${scene.clip}` }
    }
    let clipMs: number
    try {
      clipMs = (await probe(clipPath)).durationMs
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return { name, passed: false, detail: `clip unreadable: ${scene.clip} (${message})` }
    }
    if (clipMs < MIN_CLIP_MS || clipMs > MAX_CLIP_MS) {
      return {
        name,
        passed: false,
        detail: `clip ${scene.clip} probes ${clipMs}ms, outside [${MIN_CLIP_MS}, ${MAX_CLIP_MS}]ms`,
      }
    }
  }
  return {
    name,
    passed: true,
    detail: `${scenes.length} scenes tile [0, ${voiceDurationMs}ms]; all clips present and probe within [${MIN_CLIP_MS}, ${MAX_CLIP_MS}]ms`,
  }
}

// Premium check (b): sample three frames from the finished video and have the
// vision model judge them against the scene intents — catches assembly-level
// faults the per-keyframe check cannot (wrong ordering, corrupted encode,
// captions obscuring the subject). This is a paid call: budget gate before,
// ledger after. ANY thrown error (ffmpeg, budget breach, provider 5xx) degrades
// to a failed check so the job parks needs-review instead of crashing the stage.
async function visionSpotCheck(
  ctx: JobContext,
  script: ScriptArtifact | undefined,
  finalPath: string,
  finalDurationMs: number,
  client?: Anthropic,
): Promise<QcCheck> {
  const name = 'vision-spot-check'
  try {
    if (!script || !isScenesOutput(script)) {
      return { name, passed: false, detail: 'script.json missing, unreadable, or not scenes format' }
    }
    const frameDir = mkdtempSync(path.join(tmpdir(), 'brainrot-qc-frames-'))
    try {
      const framePaths: string[] = []
      for (const [i, fraction] of [0.1, 0.5, 0.9].entries()) {
        const seekSec = ((finalDurationMs * fraction) / 1000).toFixed(3)
        const framePath = path.join(frameDir, `frame-${i + 1}.png`)
        await execa('ffmpeg', ['-ss', seekSec, '-i', finalPath, '-frames:v', '1', '-y', framePath])
        framePaths.push(framePath)
      }
      const sceneList = script.scenes.map((s, i) => `Scene ${i + 1}: ${s.visualPrompt}`).join('\n')
      // Same discipline as every paid call: budget gate before, ledger after.
      assertBudget(ctx.db, ctx.channel, ctx.jobId, ESTIMATED_VISION_COST_MICROS, 'premium')
      const { data, cost } = await visionJudgment({
        model: ctx.channel.scriptModel,
        system:
          'You are a strict quality-control reviewer for AI-generated short-form vertical video. ' +
          'Judge only what is visible in the provided frames. ' +
          'Return your answer ONLY by calling the `emit` tool.',
        prompt: [
          'Three frames sampled at 10%, 50%, and 90% of the finished video, in order.',
          'The video was assembled from AI-generated scene clips with burned-in word captions; captions over the visuals are expected and fine.',
          '',
          'Scene intents, in narration order:',
          sceneList,
          '',
          'Set pass=false only for assembly-level faults: frames that match no scene intent at all, scenes clearly out of order, a corrupted or garbled encode, or captions fully obscuring the subject.',
          'Minor stylistic drift from the intents is acceptable. List each concrete issue in `issues`; return an empty issues array when passing.',
        ].join('\n'),
        imagePaths: framePaths,
        schema: SpotCheckSchema,
        client,
      })
      recordCost(ctx.db, ctx.jobId, 'anthropic', 'qc-vision', cost.usdMicros)
      return {
        name,
        passed: data.pass,
        detail: data.pass
          ? 'sampled frames consistent with scene intents'
          : data.issues.join('; ') || 'model failed the frames without naming issues',
      }
    } finally {
      rmSync(frameDir, { recursive: true, force: true })
    }
  } catch (err) {
    // Any thrown error degrades this spot check to a failed check rather than
    // crashing the stage. A BudgetExceededError here deliberately degrades to a
    // failed check (job parks needs-review), NOT blocked: the video is already
    // rendered, so a parked library row is more useful than killing the run over
    // a spot check we could not afford. A schema-invalid but paid vision response
    // still cost money — ledger it before degrading so the spend is not lost.
    const paid = errorCostUsdMicros(err)
    if (paid !== undefined) recordCost(ctx.db, ctx.jobId, 'anthropic', 'qc-vision', paid)
    return { name, passed: false, detail: err instanceof Error ? err.message : String(err) }
  }
}

export function qcStage(opts?: { minMs?: number; maxMs?: number; client?: Anthropic }): StageDef {
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
      // regenerated artifact set cannot slip through. Read as the ScriptArtifact
      // union: a premium job's script.json is a ScenesOutput, and
      // narrationWordCount handles both formats.
      const script = readJson<ScriptArtifact>(ctx.artifactPath('script', 'script.json'))
      const narrationWords = script ? narrationWordCount(script) : 0
      const minNarrationMs = minPlausibleNarrationMs(narrationWords)
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

      if (ctx.tier === 'premium') {
        checks.push(await sceneCoverageCheck(ctx, voice.durationMs))
        checks.push(await visionSpotCheck(ctx, script, finalPath, p.durationMs, opts?.client))
      }

      const result: QcResult = { passed: checks.every((c) => c.passed), checks }
      writeFileSync(ctx.artifactPath('qc', 'qc.json'), JSON.stringify(result, null, 2))
      ctx.log.info({ passed: result.passed }, 'qc: complete')
    },
  }
}
