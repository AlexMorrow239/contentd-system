export const TOPIC_STATUSES = ['candidate', 'claimed', 'used', 'rejected'] as const
export type TopicStatus = (typeof TOPIC_STATUSES)[number]
