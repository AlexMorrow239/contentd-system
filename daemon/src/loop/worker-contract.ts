/** A single unit's outcome: worked rechecks immediately; idle sleeps first. */
export interface UnitResult {
  worked: boolean
  line?: Record<string, unknown>
}
export type WorkerUnit = () => Promise<UnitResult>
export interface WorkerSpec {
  name: string
  unit: WorkerUnit
  idleSleepMs?: number
}
export interface WorkerDeps {
  time: import('../time.js').TimeSource
  emit: (line: Record<string, unknown>) => void
}
