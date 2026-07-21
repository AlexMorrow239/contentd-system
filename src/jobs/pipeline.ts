import { scriptStage } from '../stages/script.js'
import { voiceStage } from '../stages/voice.js'
import { captionsStage } from '../stages/captions.js'
import { visualsVolumeStage } from '../stages/visuals-volume.js'
import { visualsPremiumStage } from '../stages/visuals-premium.js'
import { assembleStage } from '../stages/assemble.js'
import { qcStage } from '../stages/qc.js'
import type { StageDef, Tier } from './types.js'

/**
 * Premium pre-flight: premium visuals require a fal key, so refuse the run
 * before any config load, db handle, or job row exists when FAL_KEY is absent —
 * a job that could only ever fail for a missing key should never be created.
 * ELEVENLABS_API_KEY is deliberately NOT required: premium voice falls back to
 * kokoro when it is unset. Exported so cli.test.ts can assert it in-process.
 */
export function assertPremiumPreflight(tier: Tier): void {
  if (tier === 'premium' && !process.env.FAL_KEY) {
    throw new Error(
      'premium tier requires FAL_KEY in the environment (see .env.example); aborting before any spend',
    )
  }
}

/**
 * The stage list for one produce run. Only the visuals slot branches by tier;
 * script/voice/captions/qc branch internally on ctx.tier. Exported so tests
 * can assert the premium wiring without spawning a subprocess.
 */
export function stagesForTier(tier: Tier): StageDef[] {
  return [
    scriptStage,
    voiceStage,
    captionsStage,
    tier === 'premium' ? visualsPremiumStage : visualsVolumeStage,
    assembleStage,
    qcStage(),
  ]
}
