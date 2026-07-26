import { describe, expect, it } from 'vitest'
import { html } from '../html.js'
import { dbHref, layout } from './layout.js'

describe('dbHref', () => {
  it('omits the db param for prod so normal URLs stay clean', () => {
    expect(dbHref('/jobs', 'prod')).toBe('/jobs')
  })

  it('carries the dev selection through every link', () => {
    expect(dbHref('/jobs', 'dev')).toBe('/jobs?db=dev')
  })

  it('merges extra query params', () => {
    expect(dbHref('/jobs', 'dev', { status: 'failed' })).toBe('/jobs?db=dev&status=failed')
    expect(dbHref('/jobs', 'prod', { status: 'failed' })).toBe('/jobs?status=failed')
  })

  it('encodes param values', () => {
    expect(dbHref('/jobs', 'prod', { channel: 'a b&c' })).toBe('/jobs?channel=a%20b%26c')
  })

  it('drops empty extra values so a blank filter box does not pin an empty filter', () => {
    expect(dbHref('/jobs', 'prod', { status: '' })).toBe('/jobs')
  })
})

describe('layout', () => {
  it('renders a complete document with the body inside', () => {
    const out = layout({
      title: 'Jobs',
      dbChoice: 'prod',
      activeNav: 'jobs',
      body: html`<p id="marker">hello</p>`,
    })
    expect(out.startsWith('<!doctype html>')).toBe(true)
    expect(out).toContain('<p id="marker">hello</p>')
    expect(out).toContain('<title>Jobs · brainrot</title>')
  })

  it('marks the active nav item', () => {
    const out = layout({ title: 'Jobs', dbChoice: 'prod', activeNav: 'jobs', body: html`` })
    expect(out).toContain('<a class="active" href="/jobs">jobs</a>')
  })

  it('shows a dev banner only on dev', () => {
    const dev = layout({ title: 'x', dbChoice: 'dev', activeNav: 'overview', body: html`` })
    const prod = layout({ title: 'x', dbChoice: 'prod', activeNav: 'overview', body: html`` })
    expect(dev).toContain('class="env-banner dev"')
    expect(prod).not.toContain('class="env-banner dev"')
  })

  it('keeps the dev selection on every nav link', () => {
    const out = layout({ title: 'x', dbChoice: 'dev', activeNav: 'overview', body: html`` })
    expect(out).toContain('href="/jobs?db=dev"')
    expect(out).toContain('href="/library?db=dev"')
  })

  it('emits a meta refresh only when asked', () => {
    const withRefresh = layout({
      title: 'x',
      dbChoice: 'prod',
      activeNav: 'overview',
      body: html``,
      refreshSeconds: 30,
    })
    expect(withRefresh).toContain('<meta http-equiv="refresh" content="30">')
    const without = layout({ title: 'x', dbChoice: 'prod', activeNav: 'jobs', body: html`` })
    expect(without).not.toContain('http-equiv="refresh"')
  })

  it('escapes the title', () => {
    const out = layout({
      title: '<script>',
      dbChoice: 'prod',
      activeNav: 'jobs',
      body: html``,
    })
    expect(out).toContain('<title>&lt;script&gt; · brainrot</title>')
  })
})
