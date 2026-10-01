import { type ActionLane } from './catalog.js'

export type ActionStatus = 'pending' | 'running' | 'done' | 'failed'

export interface ActionRow {
  id: number
  kind: string
  lane: ActionLane
  args: string
  status: ActionStatus
  requestedBy: string
  createdAt: string
  startedAt: string | null
  finishedAt: string | null
  result: string | null
  error: string | null
  errorKind: string | null
  notice: string | null
  ownerToken: string | null
  jobId: string | null
}
