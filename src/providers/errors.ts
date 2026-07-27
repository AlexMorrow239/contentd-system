import { errorContext } from '../errors.js'

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
 * The own-property fallback below is defensive, for a foreign error that
 * happens to carry a numeric `costUsdMicros` of its own. Nothing in this repo
 * writes that property any more.
 *
 * This keeps its own name rather than being inlined at call sites: the name is
 * what documents the ledger obligation.
 */
export function errorCostUsdMicros(err: unknown): number | undefined {
  const tagged = errorContext(err).costUsdMicros
  if (typeof tagged === 'number' && Number.isFinite(tagged)) return tagged
  if (err !== null && typeof err === 'object' && 'costUsdMicros' in err) {
    const cost = (err as { costUsdMicros?: unknown }).costUsdMicros
    if (typeof cost === 'number' && Number.isFinite(cost)) return cost
  }
  return undefined
}
