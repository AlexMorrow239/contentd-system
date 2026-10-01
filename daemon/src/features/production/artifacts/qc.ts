import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export interface QcResult {
  passed: boolean
  checks: { name: string; passed: boolean; detail: string }[]
}

/**
 * Reads this stage's artifact out of its resolved stage directory. Exported so
 * the runner's final gate does not have to know qc's own file name — every
 * stage owns the name and shape of what it writes. Missing or corrupt is
 * thrown, not tolerated: a job that reached the gate has a `done` qc stage, so
 * an unreadable qc.json is a real failure and not a legacy shape.
 */
export function readQcResult(stageDir: string): QcResult {
  return JSON.parse(readFileSync(join(stageDir, 'qc.json'), 'utf8')) as QcResult
}
