import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { PLATFORMS, type Platform } from '../../../shared/contracts/platforms.js'
import { platformEntrySchema } from '../../posting/meta.js'

// Built from PLATFORMS so adding a platform there cannot leave the script
// stage writing metadata for the old set — the /post page reads these entries
// per declared platform.
export const platformMetaSchema = z.object(
  Object.fromEntries(PLATFORMS.map((p) => [p, platformEntrySchema])) as {
    [K in Platform]: typeof platformEntrySchema
  },
)

// Mirrors the contract's ScriptOutput exactly (no length constraints — those
// are enforced by the prompt, keeping the tool input_schema constraint-free).
export const ScriptOutputSchema = z.object({
  hook: z.string(),
  segments: z.array(z.object({ text: z.string(), visualDirection: z.string() })),
  platformMeta: platformMetaSchema,
})

export type ScriptOutput = z.infer<typeof ScriptOutputSchema>

export type ScriptArtifact = ScriptOutput

/**
 * Reads this stage's artifact out of its resolved stage directory, `undefined`
 * when the run predates it. Exported so the runner's final gate does not have
 * to know script's own file name. Absent is tolerated (that is the gate's
 * documented rule); corrupt still throws, since a written-but-unparseable
 * artifact is a failure rather than an older shape.
 */
export function readScriptArtifact(stageDir: string): ScriptArtifact | undefined {
  const path = join(stageDir, 'script.json')
  if (!existsSync(path)) return undefined
  return JSON.parse(readFileSync(path, 'utf8')) as ScriptArtifact
}
