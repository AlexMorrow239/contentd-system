'use client'
import { FilterBar } from './filter-bar'
import {
  TOPIC_FILTER_KEYS,
  TOPIC_FILTER_STORAGE_KEY,
  parseTopicFilters,
} from '../lib/shared/topic-filters'
import { TOPIC_STATUSES } from '../../daemon/src/scout/topic-status'

export function TopicFiltersControl({ channels }: { channels: string[] }) {
  return (
    <FilterBar
      path="/topics"
      storageKey={TOPIC_FILTER_STORAGE_KEY}
      keys={TOPIC_FILTER_KEYS}
      parse={parseTopicFilters}
      searchLabel="Search topics"
      placeholder="Title or topic ID"
      selects={[
        {
          key: 'channel',
          label: 'Channel',
          all: 'All channels',
          options: channels.map((value) => ({ value })),
        },
        {
          key: 'status',
          label: 'Topic status',
          all: 'All statuses',
          options: TOPIC_STATUSES.map((value) => ({ value })),
        },
      ]}
    />
  )
}
