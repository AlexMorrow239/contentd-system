import { describe, expect, it } from 'vitest'
import { escapeHtml, html, httpUrlOrNull, raw, SafeHtml } from '../html.js'

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

describe('raw', () => {
  it('marks a trusted string as already-safe', () => {
    expect(html`${raw('<hr>')}`.value).toBe('<hr>')
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
