import { errorContext } from '../../shared/errors.js'

/**
 * Read the already-incurred provider spend off a thrown value, or `undefined`
 * when it carries none.
 *
 * A provider call that was billed before it failed — a schema-invalid but paid
 * LLM response — must not drop that spend on the floor: the ledger has to
 * record it. Providers signal it by tagging the thrown error
 * (`tagError(err, { ..., context: { costUsdMicros } })`), which keeps the
 * error's identity intact so callers still match `instanceof z.ZodError`.
 *
 * This keeps its own name rather than being inlined at call sites: the name is
 * what documents the ledger obligation.
 */
export function errorCostUsdMicros(err: unknown): number | undefined {
  const cost = errorContext(err).costUsdMicros
  return typeof cost === 'number' && Number.isFinite(cost) ? cost : undefined
}
