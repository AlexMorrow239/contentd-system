import { describe, expect, it } from 'vitest'
import { sameSitePath } from '../navigation.js'
describe('sameSitePath', () => {
  it.each([
    'https://evil.example',
    '//evil.example',
    '/\\evil.example',
    '/..//evil.example',
    'javascript:alert(1)',
  ])('rejects unsafe return path %s', (path) => {
    expect(sameSitePath(path)).toBeNull()
  })
  it('retains a local path and query', () => {
    expect(sameSitePath('/jobs?status=failed&channel=a')).toBe('/jobs?status=failed&channel=a')
  })
})
