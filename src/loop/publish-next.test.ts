import { describe, expect, it } from 'vitest'
import { publishExitCode } from './publish-next.js'
import type { PublishTickResult } from './publish-next.js'

/**
 * publishExitCode: the pure mapping from tick result to process exit code.
 *
 * Split from a single 1825-line publish-next.test.ts — the largest file in the
 * repo — whose eleven fixtures sat in a 300-line preamble. They now live in
 * _publish-next.fixtures.ts.
 */

describe('publishExitCode (in-process)', () => {
  it('is 0 when every result published', () => {
    const result: PublishTickResult = {
      action: 'published',
      channel: 'test',
      jobId: 'job-1',
      results: [
        { platform: 'instagram', status: 'published', seq: 1 },
        { platform: 'youtube', status: 'published', seq: 1 },
      ],
    }
    expect(publishExitCode(result)).toBe(0)
  })

  it('is 1 when any result is failed', () => {
    const result: PublishTickResult = {
      action: 'published',
      channel: 'test',
      jobId: 'job-1',
      results: [
        { platform: 'instagram', status: 'published', seq: 1 },
        { platform: 'youtube', status: 'failed', error: 'bad video' },
      ],
    }
    expect(publishExitCode(result)).toBe(1)
  })

  it('is 1 when any result is unknown', () => {
    const result: PublishTickResult = {
      action: 'published',
      channel: 'test',
      jobId: 'job-1',
      results: [
        { platform: 'instagram', status: 'unknown', error: 'no id in response' },
        { platform: 'youtube', status: 'published', seq: 1 },
      ],
    }
    expect(publishExitCode(result)).toBe(1)
  })

  it('is 1 when any result is skipped', () => {
    const result: PublishTickResult = {
      action: 'published',
      channel: 'test',
      jobId: 'job-1',
      results: [
        { platform: 'instagram', status: 'published', seq: 1 },
        { platform: 'youtube', status: 'skipped', error: 'lease lost mid-fan-out' },
      ],
    }
    expect(publishExitCode(result)).toBe(1)
  })

  it('is 1 when the action is publish-failed', () => {
    const result: PublishTickResult = {
      action: 'publish-failed',
      channel: 'test',
      jobId: 'job-1',
      results: [{ platform: 'youtube', status: 'failed', error: 'nope' }],
    }
    expect(publishExitCode(result)).toBe(1)
  })

  it('is 0 for every noop/dry-run reason', () => {
    const reasons: PublishTickResult[] = [
      { action: 'noop', reason: 'lease-held' },
      { action: 'noop', reason: 'no-publish-channel' },
      { action: 'noop', reason: 'not-in-window' },
      { action: 'noop', reason: 'paced' },
      { action: 'noop', reason: 'daily-count-met' },
      { action: 'noop', reason: 'platform-quota' },
      { action: 'noop', reason: 'no-ready-video' },
      { action: 'noop', reason: 'no-video-file' },
      { action: 'noop', reason: 'no-auth' },
      { action: 'noop', reason: 'bad-env' },
      { action: 'noop', reason: 'config-error' },
      { action: 'dry-run', wouldPublish: null },
      {
        action: 'dry-run',
        wouldPublish: { channel: 'test', jobId: 'job-1', title: 't', platforms: ['youtube'] },
      },
    ]
    for (const result of reasons) {
      expect(publishExitCode(result)).toBe(0)
    }
  })
})
