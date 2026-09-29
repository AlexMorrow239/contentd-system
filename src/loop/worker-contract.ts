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
  sleep: (ms: number) => Promise<void>
  emit: (line: Record<string, unknown>) => void
}
export type StartInterval = (callback: () => void, ms: number) => () => void
