import type { TopicRow } from '../../daemon/src/features/topics/types'

export function TopicSource({ topic }: { topic: TopicRow }) {
  const body = topic.sourceContext?.body?.trim()
  const part = topic.bodyText?.trim()
  const text = body || part
  return (
    <div>
      <span className={text ? 'source-present' : 'muted'}>
        {body
          ? 'Post body saved'
          : part
            ? 'Story part saved'
            : topic.sourceContext
              ? 'Metadata only'
              : 'No source snapshot'}
      </span>
      {text && <p className="job-secondary">{text.split(/\s+/u).length.toLocaleString()} words</p>}
    </div>
  )
}
