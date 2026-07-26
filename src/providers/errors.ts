/**
 * Cost-carrying provider errors. A provider call that has already been billed
 * before it fails — a schema-invalid but paid LLM response, or a fal asset whose
 * download fails after a paid `subscribe` — must not drop that spend on the
 * floor: the ledger has to record it. Providers signal the incurred cost in one
 * of two ways, both readable via `errorCostUsdMicros`:
 *   - throw a `ProviderCostError` (a fresh error, e.g. fal download failures), or
 *   - attach a numeric `costUsdMicros` to an existing error whose identity must
 *     survive (e.g. a ZodError the anthropic adapter keeps throwing so callers
 *     and tests still see `instanceof z.ZodError`).
 * Kept dependency-free so both providers can import it without coupling.
 */
export class ProviderCostError extends Error {
  constructor(
    message: string,
    public costUsdMicros: number,
  ) {
    super(message)
    this.name = 'ProviderCostError'
  }
}

/**
 * Read the already-incurred provider spend off a thrown value, or `undefined`
 * when it carries none. Duck-typed on purpose so it catches both a
 * `ProviderCostError` and any error with a numeric `costUsdMicros` attached.
 */
export function errorCostUsdMicros(err: unknown): number | undefined {
  if (err !== null && typeof err === 'object' && 'costUsdMicros' in err) {
    const cost = err.costUsdMicros
    if (typeof cost === 'number' && Number.isFinite(cost)) return cost
  }
  return undefined
}
