import { describe, expect, it } from 'vitest'
import { BrainrotError } from '../errors.js'
import { ACTIONS, actionArgNames, formToArgs, isActionKind, parseActionArgs } from './catalog.js'

describe('ACTIONS catalog', () => {
  it('declares exactly the phase-1 fast actions plus the phase-2 slow ones', () => {
    expect(Object.keys(ACTIONS).sort()).toEqual([
      'digest.run',
      'library.approve',
      'produce.next',
      'publish.markDone',
      'publish.next',
      'publish.nextDryRun',
      'publish.retry',
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

  it('takes the publish lease for the two actions that mutate publishes rows', () => {
    // The rest touch tables where a concurrent tick is benign; these two are
    // owned by the publish state machine.
    expect(ACTIONS['publish.retry'].lease).toBe('publish')
    expect(ACTIONS['publish.markDone'].lease).toBe('publish')
    expect(ACTIONS['topics.reject'].lease).toBeUndefined()
    expect(ACTIONS['library.approve'].lease).toBeUndefined()
  })

  it('requires confirmation only for the irreversible action', () => {
    expect(ACTIONS['publish.markDone'].confirm).toBe(true)
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
      parseActionArgs('publish.markDone', { jobId: 'j1' })
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(BrainrotError)
      expect((err as BrainrotError).domain).toBe('config')
      expect((err as BrainrotError).kind).toBe('invalid')
    }
  })

  it('derives argument names from the schema so the two cannot drift', () => {
    expect(actionArgNames('publish.markDone')).toEqual(['jobId', 'postId'])
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

  it('declares no lease for the two tick actions, which lease themselves', () => {
    // produceNextTick / publishNextTick acquire `produce` / `publish` internally.
    // A worker holding the lease first would deadlock the tick against itself
    // and record its lease-held noop as a success.
    expect(ACTIONS['produce.next'].lease).toBeUndefined()
    expect(ACTIONS['publish.next'].lease).toBeUndefined()
    expect(ACTIONS['publish.nextDryRun'].lease).toBeUndefined()
  })

  it('confirms before spending or publishing, but not for a dry run', () => {
    expect(ACTIONS['produce.next'].confirm).toBe(true)
    expect(ACTIONS['publish.next'].confirm).toBe(true)
    expect(ACTIONS['publish.nextDryRun'].confirm).toBe(false)
  })
})
