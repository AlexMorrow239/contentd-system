import type { JobContext } from './contracts.js'

/** Fence work and artifact writes after an attempt loses ownership. */
export function checkpoint(ctx: Pick<JobContext, 'assertOwned' | 'signal'>): void {
  ctx.assertOwned?.()
  ctx.signal?.throwIfAborted()
}
