import { describe, expect, it } from 'vitest'
import { attrIf, escapeHtml, html, httpUrlOrNull, safeLink, SafeHtml } from '../html.js'

describe('escapeHtml', () => {
  it('escapes every character that can break out of markup or an attribute', () => {
    expect(escapeHtml(`<script>&"'`)).toBe('&lt;script&gt;&amp;&quot;&#39;')
  })

  it('stringifies non-strings', () => {
    expect(escapeHtml(42)).toBe('42')
    expect(escapeHtml(null)).toBe('null')
  })
})

describe('html', () => {
  it('escapes interpolated values by default', () => {
    // Topic titles come from scraped Reddit/RSS via scout. This is a live path.
    const title = '<script>alert(1)</script>'
    expect(html`<td>${title}</td>`.value).toBe('<td>&lt;script&gt;alert(1)&lt;/script&gt;</td>')
  })

  it('passes SafeHtml through unescaped so views can nest', () => {
    const inner = html`<b>hi</b>`
    expect(html`<p>${inner}</p>`.value).toBe('<p><b>hi</b></p>')
  })

  it('joins arrays without separators, for row lists', () => {
    const rows = [html`<li>a</li>`, html`<li>b</li>`]
    expect(html`<ul>${rows}</ul>`.value).toBe('<ul><li>a</li><li>b</li></ul>')
  })

  it('renders null and undefined as empty, not as the words', () => {
    expect(html`<td>${null}</td>`.value).toBe('<td></td>')
    expect(html`<td>${undefined}</td>`.value).toBe('<td></td>')
  })

  it('returns SafeHtml so a template result nests without double-escaping', () => {
    expect(html`<p>x</p>`).toBeInstanceOf(SafeHtml)
  })
})

describe('httpUrlOrNull', () => {
  it('accepts a plain http url', () => {
    expect(httpUrlOrNull('http://example.com/a')).toBe('http://example.com/a')
  })

  it('accepts a plain https url', () => {
    expect(httpUrlOrNull('https://example.com/a')).toBe('https://example.com/a')
  })

  it('rejects a javascript: url', () => {
    expect(httpUrlOrNull('javascript:alert(document.cookie)')).toBeNull()
  })

  it('rejects a mixed-case JaVaScRiPt: url', () => {
    expect(httpUrlOrNull('JaVaScRiPt:alert(document.cookie)')).toBeNull()
  })

  it('rejects a data: url', () => {
    expect(httpUrlOrNull('data:text/html,<script>alert(1)</script>')).toBeNull()
  })

  it('rejects a javascript: url hidden behind leading whitespace', () => {
    expect(httpUrlOrNull('   javascript:alert(1)')).toBeNull()
  })

  it('rejects a javascript: url with an embedded newline splitting the scheme', () => {
    expect(httpUrlOrNull('java\nscript:alert(1)')).toBeNull()
  })

  it('rejects a scheme-relative url', () => {
    expect(httpUrlOrNull('//evil.example')).toBeNull()
  })

  it('rejects an unparseable string', () => {
    expect(httpUrlOrNull('not a url at all')).toBeNull()
  })
})

describe('safeLink', () => {
  it('renders an anchor with both rel tokens and target for an http url', () => {
    expect(safeLink('https://example.com/a', 'youtube').value).toBe(
      '<a href="https://example.com/a" rel="noreferrer noopener" target="_blank">youtube</a>',
    )
  })

  it('appends linkSuffix in the anchor branch only', () => {
    expect(safeLink('https://example.com/a', 'youtube', { linkSuffix: '↗' }).value).toBe(
      '<a href="https://example.com/a" rel="noreferrer noopener" target="_blank">youtube ↗</a>',
    )
    expect(safeLink('javascript:alert(1)', 'youtube', { linkSuffix: '↗' }).value).toBe(
      '<span class="warning" title="blocked unsafe link scheme">youtube</span>',
    )
  })

  it('renders a non-clickable warning span for a blocked scheme', () => {
    expect(safeLink('javascript:alert(1)', 'reddit').value).toBe(
      '<span class="warning" title="blocked unsafe link scheme">reddit</span>',
    )
  })

  it('escapes the label in both branches', () => {
    const label = '<script>alert(1)</script>'
    expect(safeLink('https://example.com/a', label).value).toContain('&lt;script&gt;')
    expect(safeLink('javascript:alert(1)', label).value).toContain('&lt;script&gt;')
  })
})

describe('attrIf', () => {
  it('emits the bare attribute when the condition holds', () => {
    expect(html`<button ${attrIf(true, 'disabled')}>x</button>`.value).toBe(
      '<button disabled>x</button>',
    )
  })

  it('emits nothing when it does not', () => {
    expect(html`<button ${attrIf(false, 'disabled')}>x</button>`.value).toBe('<button >x</button>')
  })
})
