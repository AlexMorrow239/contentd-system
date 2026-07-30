import { describe, expect, it } from 'vitest'
import { html } from '../../html.js'
import { href, layout } from '../layout.js'

describe('href', () => {
  it('returns a bare path when there are no extra params', () => {
    expect(href('/jobs')).toBe('/jobs')
  })

  it('appends extra query params', () => {
    expect(href('/jobs', { status: 'failed' })).toBe('/jobs?status=failed')
    expect(href('/jobs', { channel: 'demo', status: 'failed' })).toBe(
      '/jobs?channel=demo&status=failed',
    )
  })

  it('encodes param values', () => {
    // Hand-rolled, not URLSearchParams: that class encodes a space as '+'.
    expect(href('/jobs', { channel: 'a b&c' })).toBe('/jobs?channel=a%20b%26c')
  })

  it('drops empty extra values so a blank filter box does not pin an empty filter', () => {
    expect(href('/jobs', { status: '' })).toBe('/jobs')
  })
})

describe('layout', () => {
  it('renders a complete document with the body inside', () => {
    const out = layout({
      title: 'Jobs',
      root: 'local',
      activeNav: 'jobs',
      body: html`<p id="marker">hello</p>`,
    })
    expect(out.startsWith('<!doctype html>')).toBe(true)
    expect(out).toContain('<p id="marker">hello</p>')
    expect(out).toContain('<title>Jobs · brainrot</title>')
  })

  it('marks the active nav item', () => {
    const out = layout({ title: 'Jobs', root: 'local', activeNav: 'jobs', body: html`` })
    expect(out).toContain('<a class="active" href="/jobs">jobs</a>')
  })

  it('names the root it is serving in the footer', () => {
    // A dashboard cannot say "you are in dev mode" anymore — mode is not
    // something it knows. It can say exactly which directory it reads.
    const out = layout({ title: 'Jobs', root: '/app/state', activeNav: 'jobs', body: html`` })
    expect(out).toContain('/app/state')
  })

  it('emits a meta refresh only when asked', () => {
    const withRefresh = layout({
      title: 'x',
      root: 'local',
      activeNav: 'overview',
      body: html``,
      refreshSeconds: 30,
    })
    expect(withRefresh).toContain('<meta http-equiv="refresh" content="30">')
    const without = layout({ title: 'x', root: 'local', activeNav: 'jobs', body: html`` })
    expect(without).not.toContain('http-equiv="refresh"')
  })

  it('escapes the title', () => {
    const out = layout({
      title: '<script>',
      root: 'local',
      activeNav: 'jobs',
      body: html``,
    })
    expect(out).toContain('<title>&lt;script&gt; · brainrot</title>')
  })
})
