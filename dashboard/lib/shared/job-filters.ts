import type { LibraryState } from '../../../daemon/src/features/library/library.js'
import { filterText, filtersUrl } from './filters.js'

export const JOB_STATUSES = ['queued', 'running', 'failed', 'done', 'blocked'] as const
export const REVIEW_STATES = ['none', 'ready', 'needs-review', 'blocked'] as const
export const POSTING_STATES = ['unposted', 'partial', 'full', 'has-posts'] as const
export const REVIEW_LABELS: Record<'none' | LibraryState, string> = {
  none: 'No video',
  ready: 'Ready',
  'needs-review': 'Needs review',
  blocked: 'Discarded',
} satisfies Record<(typeof REVIEW_STATES)[number], string>
export const POSTING_LABELS: Record<(typeof POSTING_STATES)[number], string> = {
  unposted: 'Unposted',
  partial: 'Partially posted',
  full: 'Fully posted',
  'has-posts': 'Any posting history',
}
export const JOB_FILTER_KEYS = ['q', 'channel', 'status', 'review', 'posting'] as const
export const JOBS_PAGE_SIZE = 50
export const JOB_FILTER_STORAGE_KEY = 'contentd.jobs.filters.v1'

export type JobFilters = {
  q?: string
  channel?: string
  status?: (typeof JOB_STATUSES)[number]
  review?: (typeof REVIEW_STATES)[number]
  posting?: (typeof POSTING_STATES)[number]
}

export function parseJobFilters(raw: Record<string, unknown>): JobFilters {
  const member = <T extends string>(values: readonly T[], key: string) =>
    values.find((v) => v === raw[key])
  return {
    q: filterText(raw.q),
    channel: filterText(raw.channel),
    status: member(JOB_STATUSES, 'status'),
    review: member(REVIEW_STATES, 'review'),
    posting: member(POSTING_STATES, 'posting'),
  }
}

export function jobsUrl(filters: JobFilters, page = 1): string {
  return filtersUrl('/jobs', JOB_FILTER_KEYS, filters, page)
}
