export type FilterValues = Record<string, string | undefined>

export function filtersUrl(
  path: string,
  keys: readonly string[],
  filters: FilterValues,
  page = 1,
): string {
  const search = new URLSearchParams()
  for (const key of keys) if (filters[key]) search.set(key, filters[key])
  if (page > 1) search.set('page', String(page))
  return `${path}${search.size ? `?${search.toString()}` : ''}`
}

export function pageNumber(raw: unknown): number {
  const page = typeof raw === 'string' ? Number(raw) : 1
  return Number.isSafeInteger(page) && page > 0 ? page : 1
}

export function filterText(raw: unknown): string | undefined {
  return typeof raw === 'string' ? raw.trim() || undefined : undefined
}
