import { describe, expect, it } from 'vitest'
import { httpUrlOrNull } from '../links.js'

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
