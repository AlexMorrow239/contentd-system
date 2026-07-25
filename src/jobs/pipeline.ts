import { scriptStage } from '../stages/script.js'
import { voiceStage } from '../stages/voice.js'
import { captionsStage } from '../stages/captions.js'
import { visualsVolumeStage } from '../stages/visuals-volume.js'
import { assembleStage } from '../stages/assemble.js'
import { qcStage } from '../stages/qc.js'
import type { StageDef } from './types.js'

/**
 * The fixed stage list for one produce run. Exported so tests can assert the
 * wiring without spawning a subprocess.
 */
export function pipelineStages(): StageDef[] {
  return [scriptStage, voiceStage, captionsStage, visualsVolumeStage, assembleStage, qcStage()]
}
