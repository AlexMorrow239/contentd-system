export function sameSitePath(from: string): string | null {
  if (!from.startsWith('/')) return null
  let resolved: URL
  try {
    resolved = new URL(from, 'http://brainrot.invalid')
  } catch {
    return null
  }
  if (resolved.origin !== 'http://brainrot.invalid') return null
  const path = `${resolved.pathname}${resolved.search}`
  // A normalized pathname can never contain a raw backslash, so this
  // output-side prefix check is sound where the input-side one was not.
  if (!path.startsWith('/') || path.startsWith('//')) return null
  return path
}
