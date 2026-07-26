import { describe, expect, it } from 'vitest'
import { join, sep } from 'node:path'
import { parseRange, resolveVideoPath } from './video.js'

describe('parseRange', () => {
  it('returns null with no header, so the caller sends the whole file', () => {
    expect(parseRange(undefined, 1000)).toBeNull()
  })

  it('parses a closed range', () => {
    expect(parseRange('bytes=0-499', 1000)).toEqual({ start: 0, end: 499 })
  })

  it('parses an open-ended range', () => {
    expect(parseRange('bytes=500-', 1000)).toEqual({ start: 500, end: 999 })
  })

  it('parses a suffix range', () => {
    expect(parseRange('bytes=-200', 1000)).toEqual({ start: 800, end: 999 })
  })

  it('clamps an end past the file size', () => {
    expect(parseRange('bytes=0-99999', 1000)).toEqual({ start: 0, end: 999 })
  })

  it('rejects a start past the end of the file', () => {
    expect(parseRange('bytes=2000-', 1000)).toBeNull()
  })

  it('rejects reversed and malformed ranges', () => {
    expect(parseRange('bytes=500-100', 1000)).toBeNull()
    expect(parseRange('bytes=abc', 1000)).toBeNull()
    expect(parseRange('bytes=-', 1000)).toBeNull()
    expect(parseRange('items=0-10', 1000)).toBeNull()
  })

  it('rejects a zero-length suffix', () => {
    expect(parseRange('bytes=-0', 1000)).toBeNull()
  })

  it('rejects any range on a zero-byte file, falling through to the whole-file 200 path', () => {
    // parseRange('bytes=-200', 0) would otherwise return { start: 0, end: -1 },
    // which the route turns into a malformed 206 with content-range: bytes 0--1/0.
    expect(parseRange('bytes=-200', 0)).toBeNull()
    expect(parseRange('bytes=0-', 0)).toBeNull()
  })
})

describe('resolveVideoPath', () => {
  const root = join(sep, 'app', 'runs')

  it('accepts a path inside the runs root', () => {
    expect(resolveVideoPath(root, join(root, 'j1', 'assemble', 'final.mp4'))).toBe(
      join(root, 'j1', 'assemble', 'final.mp4'),
    )
  })

  it('rejects traversal out of the runs root', () => {
    // library.video_path is database-sourced, not user-supplied — but a
    // malformed row must not become an arbitrary file read.
    expect(resolveVideoPath(root, join(root, '..', '..', 'etc', 'passwd'))).toBeNull()
  })

  it('rejects a sibling directory that merely shares the prefix', () => {
    // '/app/runs-evil' must not pass a naive startsWith('/app/runs') check.
    expect(resolveVideoPath(root, join(sep, 'app', 'runs-evil', 'x.mp4'))).toBeNull()
  })

  it('rejects the runs root itself', () => {
    expect(resolveVideoPath(root, root)).toBeNull()
  })
})
