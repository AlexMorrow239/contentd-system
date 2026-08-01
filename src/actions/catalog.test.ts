import { describe, expect, it } from 'vitest'
import { BrainrotError } from '../errors.js'
import { ACTIONS, actionArgNames, formToArgs, isActionKind, parseActionArgs } from './catalog.js'

describe('ACTIONS catalog', () => {
  it('declares exactly the phase-1 fast actions', () => {
    expect(Object.keys(ACTIONS).sort()).toEqual([
      'digest.run',
      'library.approve',
      'publish.markDone',
      'publish.retry',
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

  it('groups repeated form keys into arrays and leaves single keys scalar', () => {
    expect(
      formToArgs([
        ['ids', '1'],
        ['ids', '2'],
        ['jobId', 'j1'],
      ]),
    ).toEqual({ ids: ['1', '2'], jobId: 'j1' })
  })
})
