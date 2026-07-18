import type { Database } from 'better-sqlite3'
import type { Logger } from 'pino'
import type { ChannelConfig } from '../config/channel.js'

export type Tier = 'volume' | 'premium'
export type StageName = 'script' | 'voice' | 'captions' | 'visuals' | 'assemble' | 'qc'

export const STAGE_ORDER: StageName[] = [
  'script',
  'voice',
  'captions',
  'visuals',
  'assemble',
  'qc',
]

export interface JobContext {
  jobId: string
  db: Database
  channel: ChannelConfig
  tier: Tier
  topic: string
  runDir: string
  artifactPath(stage: StageName, file: string): string
  log: Logger
}

export interface StageDef {
  name: StageName
  run(ctx: JobContext): Promise<void>
}
