import type { JobContext } from '../jobs/types.js'

/** Fence new work and artifact writes after an attempt loses ownership. */
export function checkpoint(ctx: JobContext): void {
  ctx.assertOwned?.()
  ctx.signal?.throwIfAborted()
}
