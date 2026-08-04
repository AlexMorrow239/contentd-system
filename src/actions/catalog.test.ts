import { describe, expect, it } from 'vitest'
import { BrainrotError } from '../errors.js'
import { ACTIONS, actionArgNames, formToArgs, isActionKind, parseActionArgs } from './catalog.js'

describe('ACTIONS catalog', () => {
  it('declares exactly the phase-1 fast actions plus the phase-2 slow ones and the posts trio', () => {
    expect(Object.keys(ACTIONS).sort()).toEqual([
      'digest.run',
      'jobs.resume',
      'library.approve',
      'library.reject',
      'post.mark',
      'post.unmark',
      'produce.next',
      'scout.run',
      'topics.reject',
      'topics.requeue',
    ])
  })

  it('gives every descriptor a lane, a label and a confirm flag', () => {
    for (const [kind, desc] of Object.entries(ACTIONS)) {
      expect(['fast', 'slow'], kind).toContain(desc.lane)
      expect(desc.label.length, kind).toBeGreaterThan(0)
      expect(typeof desc.confirm, kind).toBe('boolean')
    }
  })

  it('declares no lease for actions that touch tables where a concurrent tick is benign', () => {
    expect(ACTIONS['topics.reject'].lease).toBeUndefined()
    expect(ACTIONS['library.approve'].lease).toBeUndefined()
  })

  it('requires confirmation only for irreversible actions', () => {
    expect(ACTIONS['jobs.resume'].confirm).toBe(true)
    // A per-row interstitial would make the most-used action worse than the CLI.
    expect(ACTIONS['topics.reject'].confirm).toBe(false)
  })

  it('narrows an unknown kind', () => {
    expect(isActionKind('topics.reject')).toBe(true)
    expect(isActionKind('topics.nuke')).toBe(false)
    expect(isActionKind(7)).toBe(false)
  })

  it('coerces a single form value into a list argument', () => {
    // A form posting one checkbox sends a bare string, not an array.
    expect(parseActionArgs('topics.reject', { ids: '12' })).toEqual({ ids: [12] })
    expect(parseActionArgs('topics.reject', { ids: ['12', '13'] })).toEqual({ ids: [12, 13] })
  })

  it('rejects an empty list rather than queueing a no-op', () => {
    expect(() => parseActionArgs('topics.reject', {})).toThrow(BrainrotError)
  })

  it('rejects a non-numeric topic id', () => {
    expect(() => parseActionArgs('topics.reject', { ids: 'all' })).toThrow(BrainrotError)
  })

  it('classifies a schema failure as config/invalid', () => {
    try {
      parseActionArgs('jobs.resume', {})
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(BrainrotError)
      expect((err as BrainrotError).domain).toBe('config')
      expect((err as BrainrotError).kind).toBe('invalid')
    }
  })

  it('derives argument names from the schema so the two cannot drift', () => {
    expect(actionArgNames('jobs.resume')).toEqual(['jobId'])
    expect(actionArgNames('digest.run')).toEqual([])
  })

  it('never declares an argument named kind, csrf or from', () => {
    // src/dashboard/server.ts's TRANSPORT_FIELDS (`kind`, CSRF_FIELD = 'csrf',
    // `from`) strips these three from the submitted form before args are
    // parsed, so an action declaring one of them as a real argument would have
    // it silently dropped rather than rejected — a bug that would otherwise
    // stay latent until someone actually added such an action. Turning it into
    // a red test here, ahead of the collision, is cheaper than debugging it
    // through the confirm interstitial later.
    const reserved = new Set(['kind', 'csrf', 'from'])
    for (const kind of Object.keys(ACTIONS) as (keyof typeof ACTIONS)[]) {
      for (const name of actionArgNames(kind)) {
        expect(reserved.has(name), `${kind} declares reserved argument name "${name}"`).toBe(false)
      }
    }
  })

  it('groups repeated form keys into arrays and leaves single keys scalar', () => {
    expect(
      formToArgs([
        ['ids', '1'],
        ['ids', '2'],
        ['jobId', 'j1'],
      ]),
    ).toEqual({ ids: ['1', '2'], jobId: 'j1' })
  })

  it('does not let a repeated __proto__ field reach Object.prototype', () => {
    // The accumulator is Object.create(null), so a `__proto__` key is just an
    // own property like any other — it must not pollute Object.prototype for
    // every other object in the process.
    const before = ({} as Record<string, unknown>).polluted
    const out = formToArgs([
      ['__proto__', 'a'],
      ['__proto__', 'b'],
    ])
    expect(Object.getPrototypeOf({})).toBe(Object.prototype)
    expect(({} as Record<string, unknown>).polluted).toBe(before)
    expect(out.__proto__).toEqual(['a', 'b'])
  })

  it('accepts the null-prototype object formToArgs produces', () => {
    // parseActionArgs' zod schemas must not choke on an accumulator with no
    // prototype — Object.entries/Object.fromEntries and zod's own object
    // parsing all work by own-enumerable-key iteration, not prototype walk,
    // but this pins that behaviour rather than assuming it.
    const fields = formToArgs([
      ['ids', '4'],
      ['ids', '5'],
    ])
    expect(Object.getPrototypeOf(fields)).toBeNull()
    expect(parseActionArgs('topics.reject', fields)).toEqual({ ids: [4, 5] })
  })

  it('declares no lease for produce.next, which leases itself', () => {
    // produceNextTick acquires `produce` internally. A worker holding the
    // lease first would deadlock the tick against itself and record its
    // lease-held noop as a success.
    expect(ACTIONS['produce.next'].lease).toBeUndefined()
  })

  it('confirms before spending', () => {
    expect(ACTIONS['produce.next'].confirm).toBe(true)
  })

  it('jobs.resume takes the produce lease and offers no force escape hatch', () => {
    expect(ACTIONS['jobs.resume'].lease).toBe('produce')
    expect(ACTIONS['jobs.resume'].confirm).toBe(true)
    // Taking over a job stuck in `running` asserts no live process holds it —
    // something the dashboard cannot verify. Break-glass stays on the CLI.
    expect(actionArgNames('jobs.resume')).toEqual(['jobId'])
  })

  it('validates post.mark args, defaulting url to absent', () => {
    expect(parseActionArgs('post.mark', { jobId: 'j1', platform: 'youtube' })).toEqual({
      jobId: 'j1',
      platform: 'youtube',
    })
  })

  it('rejects an unknown platform for post.mark', () => {
    expect(() => parseActionArgs('post.mark', { jobId: 'j1', platform: 'myspace' })).toThrow(
      /platform/,
    )
  })

  // An empty url field submits as '' from a form, which is "not provided",
  // not "the url is the empty string".
  it('treats an empty url field as absent', () => {
    expect(parseActionArgs('post.mark', { jobId: 'j1', platform: 'youtube', url: '' })).toEqual({
      jobId: 'j1',
      platform: 'youtube',
    })
  })

  it('routes the destructive actions through the interstitial', () => {
    expect(ACTIONS['post.unmark'].confirm).toBe(true)
    expect(ACTIONS['library.reject'].confirm).toBe(true)
    expect(ACTIONS['post.mark'].confirm).toBe(false)
  })

  it('takes no lease for any posts action', () => {
    expect(ACTIONS['post.mark'].lease).toBeUndefined()
    expect(ACTIONS['post.unmark'].lease).toBeUndefined()
    expect(ACTIONS['library.reject'].lease).toBeUndefined()
  })
})
