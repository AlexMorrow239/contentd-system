import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { QcResult } from '../../../../../daemon/src/features/production/artifacts/qc.js'
import { tmpDir } from '../../../../../daemon/testing/tmp.js'
import { libraryBytes, summarizeQc } from '../library.js'

describe('summarizeQc', () => {
  it('summarizes a fully passing qc verdict as ok', () => {
    const qcJson = JSON.stringify({
      passed: true,
      checks: [{ name: 'duration-bounds', passed: true, detail: 'duration 30000ms' }],
    })
    expect(summarizeQc(qcJson)).toEqual({ kind: 'ok' })
  })

  it('surfaces each failing check as a name: detail issue', () => {
    // `satisfies QcResult` pins this fixture to the writer's real shape: a
    // rename in stages/qc.ts would otherwise degrade every row to
    // 'unparseable' with no failing test.
    const verdict = {
      passed: false,
      checks: [
        { name: 'resolution', passed: true, detail: '1080x1920' },
        {
          name: 'duration-bounds',
          passed: false,
          detail: 'duration 14200ms; bounds [15000,180000]; voice 14100ms',
        },
        { name: 'has-audio', passed: false, detail: 'no audio stream' },
      ],
    } satisfies QcResult
    expect(summarizeQc(JSON.stringify(verdict))).toEqual({
      kind: 'issues',
      issues: [
        'duration-bounds: duration 14200ms; bounds [15000,180000]; voice 14100ms',
        'has-audio: no audio stream',
      ],
    })
  })

  it('reports a row with no recorded verdict as absent rather than inventing one', () => {
    // NULL qc_json is every row finalized before the column existed.
    expect(summarizeQc(null)).toEqual({ kind: 'absent' })
  })

  it('treats malformed json as unparseable', () => {
    expect(summarizeQc('not json{{')).toEqual({ kind: 'unparseable' })
  })

  it('treats a verdict missing its checks array as unparseable', () => {
    expect(summarizeQc(JSON.stringify({ passed: true }))).toEqual({ kind: 'unparseable' })
  })

  it('treats a malformed check entry as unparseable rather than inventing an issue', () => {
    expect(summarizeQc(JSON.stringify({ passed: true, checks: [{}] }))).toEqual({
      kind: 'unparseable',
    })
  })
})

describe('libraryBytes', () => {
  it('reports a missing local video', () => {
    expect(libraryBytes({ video_path: '/definitely/missing/final.mp4' })).toBe('missing')
  })

  it('reports an existing local file as local', () => {
    const videoPath = join(tmpDir('lib'), 'final.mp4')
    writeFileSync(videoPath, 'video')
    expect(libraryBytes({ video_path: videoPath })).toBe('local')
  })
})
