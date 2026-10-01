import { resolveTime } from '../../shared/time.js'
import { parseActionArgs, type ActionKind } from './catalog.js'
import { ActionContext, Handler } from './handler-contract.js'
import { FAST_HANDLERS } from './handlers-fast.js'
import { SLOW_HANDLERS } from './handlers-slow.js'

export const ACTION_HANDLERS: { [K in ActionKind]: Handler<K> } = {
  ...FAST_HANDLERS,
  ...SLOW_HANDLERS,
}

/**
 * Parse-then-dispatch. Args are validated here as well as at the HTTP edge, so
 * a row hand-inserted into the queue cannot reach a handler unvalidated.
 *
 * The cast is the one unavoidable seam: `ACTION_HANDLERS` is a mapped type
 * whose value type depends on the key, and TypeScript cannot prove the
 * correlation once the key is widened to the union. Both sides are pinned by
 * the drift test in handlers.test.ts.
 */
export async function runAction(
  ctx: ActionContext,
  kind: ActionKind,
  rawArgs: unknown,
): Promise<unknown> {
  resolveTime(ctx.time, ctx.lease, ctx.daemonLease)
  ctx.daemonLease?.assertOwned()
  ctx.lease?.assertOwned()
  const args = parseActionArgs(kind, rawArgs)
  const handler = ACTION_HANDLERS[kind] as (ctx: ActionContext, args: unknown) => Promise<unknown>
  return handler(ctx, args)
}
