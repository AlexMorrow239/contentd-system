import { describe, expect, it } from 'vitest'
import type { JobDetail, JobListRow } from '../../queries/jobs.js'
import { formatUsd, renderJobDetailPage, renderJobsPage } from '../jobs.js'

const job: JobListRow = {
  id: 'j1',
  channel: 'space',
  tier: 'volume',
  topic: 'Why Venus is hot',
  status: 'failed',
  createdAt: '2026-07-24T10:00:00.000Z',
  finishedAt: null,
  costUsdMicros: 42000,
}

describe('formatUsd', () => {
  it('renders micros as dollars', () => {
    expect(formatUsd(42000)).toBe('$0.04')
    expect(formatUsd(1_500_000)).toBe('$1.50')
    expect(formatUsd(0)).toBe('$0.00')
  })
})

describe('renderJobsPage', () => {
  it('lists jobs with a link to the drill-in', () => {
    const out = renderJobsPage({
      jobs: [job],
      channels: ['space'],
      filter: {},
      dbChoice: 'prod',
    }).value
    expect(out).toContain('href="/jobs/j1"')
    expect(out).toContain('Why Venus is hot')
    expect(out).toContain('$0.04')
  })

  it('escapes a hostile topic title', () => {
    // Topics arrive from scraped Reddit/RSS through scout.
    const out = renderJobsPage({
      jobs: [{ ...job, topic: '<script>alert(1)</script>' }],
      channels: ['space'],
      filter: {},
      dbChoice: 'prod',
    }).value
    expect(out).not.toContain('<script>alert(1)</script>')
    expect(out).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
  })

  it('keeps the dev selection on drill-in links', () => {
    const out = renderJobsPage({ jobs: [job], channels: [], filter: {}, dbChoice: 'dev' }).value
    expect(out).toContain('href="/jobs/j1?db=dev"')
  })

  it('says so when nothing matches instead of rendering an empty table', () => {
    const out = renderJobsPage({ jobs: [], channels: [], filter: {}, dbChoice: 'prod' }).value
    expect(out).toContain('no jobs match')
  })

  it('preselects the active filters', () => {
    const out = renderJobsPage({
      jobs: [],
      channels: ['space', 'ocean'],
      filter: { channel: 'ocean', status: 'failed' },
      dbChoice: 'prod',
    }).value
    expect(out).toContain('<option value="ocean" selected>ocean</option>')
    expect(out).toContain('<option value="failed" selected>failed</option>')
  })

  it('shows a truncation notice when the 200-row cap cut the list', () => {
    const out = renderJobsPage({
      jobs: [job],
      total: 1432,
      channels: [],
      filter: {},
      dbChoice: 'prod',
    }).value
    expect(out).toContain('showing 1 of 1,432')
  })

  it('shows no truncation notice when the total equals what is shown', () => {
    const out = renderJobsPage({
      jobs: [job],
      total: 1,
      channels: [],
      filter: {},
      dbChoice: 'prod',
    }).value
    expect(out).not.toContain('showing')
  })
})

describe('renderJobDetailPage', () => {
  const detail: JobDetail = {
    job,
    stages: [
      {
        stage: 'script',
        status: 'done',
        error: null,
        startedAt: '2026-07-24T10:00:00.000Z',
        finishedAt: '2026-07-24T10:00:30.000Z',
      },
      {
        stage: 'voice',
        status: 'failed',
        error: 'elevenlabs 401',
        startedAt: '2026-07-24T10:00:30.000Z',
        finishedAt: null,
      },
      { stage: 'captions', status: 'pending', error: null, startedAt: null, finishedAt: null },
    ],
    costs: [
      {
        provider: 'anthropic',
        operation: 'script',
        usdMicros: 12000,
        createdAt: '2026-07-24T10:00:10.000Z',
      },
    ],
    libraryState: null,
    videoPath: null,
    bytes: null,
    links: [],
  }

  it('renders the stage timeline with durations and the raw error', () => {
    const out = renderJobDetailPage(detail, 'prod').value
    expect(out).toContain('script')
    expect(out).toContain('30s')
    expect(out).toContain('elevenlabs 401')
    expect(out).toContain('pending')
  })

  it('shows the artifact directory', () => {
    const out = renderJobDetailPage(detail, 'prod').value
    expect(out).toContain('runs/j1/')
  })

  it('links to the video only when the library row has one', () => {
    expect(renderJobDetailPage(detail, 'prod').value).not.toContain('/library/j1/video')
    const withVideo: JobDetail = {
      ...detail,
      libraryState: 'ready',
      videoPath: 'runs/j1/assemble/final.mp4',
      bytes: 'local',
    }
    expect(renderJobDetailPage(withVideo, 'prod').value).toContain('/library/j1/video')
  })

  it('says the video is archived instead of rendering a dead player', () => {
    const archived: JobDetail = {
      ...detail,
      libraryState: 'ready',
      videoPath: 'runs/j1/assemble/final.mp4',
      bytes: 'archived',
    }
    const out = renderJobDetailPage(archived, 'prod').value
    expect(out).not.toContain('/library/j1/video')
    expect(out).not.toContain('<video')
    expect(out).toContain('archived to object storage — not available locally')
  })

  it('says the video is reclaimed instead of rendering a dead player', () => {
    const reclaimed: JobDetail = {
      ...detail,
      libraryState: 'published',
      videoPath: 'runs/j1/assemble/final.mp4',
      bytes: 'reclaimed',
    }
    const out = renderJobDetailPage(reclaimed, 'prod').value
    expect(out).not.toContain('/library/j1/video')
    expect(out).not.toContain('<video')
    expect(out).toContain('reclaimed — the stored object was deleted after every platform settled')
  })

  it('renders a live link per platform that published', () => {
    const withLinks: JobDetail = {
      ...detail,
      libraryState: 'published',
      videoPath: 'runs/j1/assemble/final.mp4',
      bytes: 'local',
      links: [{ platform: 'youtube', url: 'https://youtu.be/abc' }],
    }
    const out = renderJobDetailPage(withLinks, 'prod').value
    expect(out).toContain('href="https://youtu.be/abc"')
    expect(out).toContain('youtube')
  })

  it('escapes an error message containing markup', () => {
    const hostile: JobDetail = {
      ...detail,
      stages: [{ ...detail.stages[1], error: '<img src=x onerror=alert(1)>' }],
    }
    const out = renderJobDetailPage(hostile, 'prod').value
    expect(out).not.toContain('<img src=x')
    expect(out).toContain('&lt;img src=x')
  })
})
