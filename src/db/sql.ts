/**
 * SQL text helpers shared by every DAO. Deliberately in its own module rather
 * than `./index.ts`: that module constructs database handles, and a caller
 * assembling a query string has no business dragging better-sqlite3 in.
 */

/**
 * `?, ?, ?` for an `IN (…)` list. The only correct way to interpolate a
 * variable-length list — the values themselves stay bound parameters.
 * Callers must still refuse an empty list before building the query: `IN ()`
 * is a syntax error, not an empty match.
 */
export function sqlPlaceholders(n: number): string {
  return Array.from({ length: n }, () => '?').join(', ')
}

/**
 * Builds an optional-filter WHERE from `[fragment, value]` pairs, dropping
 * every pair whose value is `undefined`. Returns the clause with a LEADING
 * space (or `''`), so callers concatenate it straight after the FROM/JOIN text
 * without conditionally adding one.
 *
 * `null` is a value, not an absence: a pair carrying it is kept and bound, so
 * a caller wanting `IS NULL` writes that fragment itself rather than having
 * the filter silently dropped.
 */
export function whereClause(pairs: readonly (readonly [fragment: string, value: unknown])[]): {
  clause: string
  params: unknown[]
} {
  const fragments: string[] = []
  const params: unknown[] = []
  for (const [fragment, value] of pairs) {
    if (value === undefined) continue
    fragments.push(fragment)
    params.push(value)
  }
  return {
    clause: fragments.length > 0 ? ` WHERE ${fragments.join(' AND ')}` : '',
    params,
  }
}
