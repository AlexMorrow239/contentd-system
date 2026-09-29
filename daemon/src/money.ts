/**
 * Micro-USD is the ledger's only unit (`costs.usd_micros`, the channel budget
 * caps): integers, so no float drift accumulates across a day's rows. This
 * module owns the two conversions at the edges — parsing an operator-written
 * USD figure in, and rendering one out — and imports nothing, so every layer
 * can reach it (the `daemon/src/time.ts` precedent).
 */

/** The one money-rendering rule: two decimal places, dollar-prefixed. */
export function formatUsdMicros(micros: number): string {
  return `$${(micros / 1_000_000).toFixed(2)}`
}

/** Rounds, so a TOML `0.05` becomes exactly 50000 rather than 49999.99…. */
export function usdToMicros(usd: number): number {
  return Math.round(usd * 1_000_000)
}
