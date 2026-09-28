import { describe, expect, it } from 'vitest'
import { redditSource } from '../reddit.js'

// Runs only via `pnpm test:contract` (excluded from default `pnpm test`).
// Two real GETs against the public Arctic Shift API — free and keyless, so
// there is no skip gate. This is the only check that the archive still honors
// `fields`, `md2html` and the `{data}` envelope the source's fixtures model: a
// silent md2html regression would otherwise make every story candidate
// bodyless, and a changed envelope would read as an outage.
describe('redditSource (contract)', () => {
  it("maps r/space's newest posts to reddit-keyed candidates", async () => {
    const got = await redditSource('space').fetch({ limit: 25, timeoutMs: 20_000 })

    expect(got.length).toBeGreaterThan(0)
    for (const c of got) {
      expect(c.externalId).toMatch(/^t3_[0-9a-z]+$/)
      expect(c.url).toBe(`https://www.reddit.com/r/space/comments/${c.externalId.slice(3)}/`)
    }
    expect(got.some((c) => c.targetUrl !== undefined)).toBe(true)
  }, 30_000)

  it("renders r/AmItheAsshole's self posts to plain-text bodies", async () => {
    const got = await redditSource('AmItheAsshole').fetch({ limit: 25, timeoutMs: 20_000 })

    const bodies = got.flatMap((c) => (c.body === undefined ? [] : [c.body]))
    expect(bodies.length).toBeGreaterThan(0)
    for (const body of bodies) expect(body).not.toMatch(/<\/?[a-z][^>]*>/i)
  }, 30_000)
})
