export function httpUrlOrNull(input: string): string | null {
  // Mirror the whitespace/control-character stripping browsers do when
  // parsing a URL from an href before navigation, so this check can't be
  // bypassed by hiding the scheme behind characters that get discarded later.
  const stripped = input.replace(/[\t\n\r]+/g, '').trim()
  let parsed: URL
  try {
    parsed = new URL(stripped)
  } catch {
    return null
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
  return input
}
