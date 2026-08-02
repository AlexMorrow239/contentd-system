// 'YYYY-MM-DD' in the MACHINE's local time zone — never toISOString() (that
// renders UTC). Callers that key a day off this (digest windows, quota
// tracking, the daemon's once-a-day digest gate) deliberately use the
// operator's calendar day, not UTC's.
export function localDay(now: Date): string {
  const year = now.getFullYear()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}
