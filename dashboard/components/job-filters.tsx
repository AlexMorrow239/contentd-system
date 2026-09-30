'use client'
import { FilterBar } from './filter-bar'
import {
  JOB_FILTER_KEYS,
  JOB_FILTER_STORAGE_KEY,
  JOB_STATUSES,
  POSTING_LABELS,
  POSTING_STATES,
  REVIEW_LABELS,
  REVIEW_STATES,
  parseJobFilters,
} from '../lib/shared/job-filters'

export function JobFiltersControl({ channels }: { channels: string[] }) {
  return (
    <FilterBar
      path="/jobs"
      storageKey={JOB_FILTER_STORAGE_KEY}
      keys={JOB_FILTER_KEYS}
      parse={parseJobFilters}
      searchLabel="Search jobs"
      placeholder="Topic or job ID"
      selects={[
        {
          key: 'channel',
          label: 'Channel',
          all: 'All channels',
          options: channels.map((value) => ({ value })),
        },
        {
          key: 'status',
          label: 'Job status',
          all: 'All statuses',
          options: JOB_STATUSES.map((value) => ({ value })),
        },
        {
          key: 'review',
          label: 'Video review',
          all: 'All videos',
          options: REVIEW_STATES.map((value) => ({ value, label: REVIEW_LABELS[value] })),
        },
        {
          key: 'posting',
          label: 'Posting progress',
          all: 'All posting states',
          options: POSTING_STATES.map((value) => ({ value, label: POSTING_LABELS[value] })),
        },
      ]}
    />
  )
}
