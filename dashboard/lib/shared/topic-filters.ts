import { TOPIC_STATUSES, type TopicStatus } from '../../../daemon/src/features/topics/status.js'
import { filterText, filtersUrl } from './filters.js'

export const TOPIC_FILTER_KEYS = ['q', 'channel', 'status'] as const
export const TOPIC_FILTER_STORAGE_KEY = 'brainrot.topics.filters.v1'
export const TOPICS_PAGE_SIZE = 50
export type TopicFilters = { q?: string; channel?: string; status?: TopicStatus }

export function parseTopicFilters(raw: Record<string, unknown>): TopicFilters {
  return {
    q: filterText(raw.q),
    channel: filterText(raw.channel),
    status: TOPIC_STATUSES.find((value) => value === raw.status),
  }
}

export function topicsUrl(filters: TopicFilters, page = 1): string {
  return filtersUrl('/topics', TOPIC_FILTER_KEYS, filters, page)
}
