import type { StageDef } from './contracts.js'
import { assembleStage } from './stages/assemble.js'
import { captionsStage } from './stages/captions.js'
import { qcStage } from './stages/qc.js'
import { scriptStage } from './stages/script.js'
import { visualsVolumeStage } from './stages/visuals-volume.js'
import { voiceStage } from './stages/voice.js'

/**
 * The fixed stage list for one produce run. Exported so tests can assert the
 * wiring without spawning a subprocess.
 */
export function pipelineStages(): StageDef[] {
  return [scriptStage, voiceStage, captionsStage, visualsVolumeStage, assembleStage, qcStage()]
}
