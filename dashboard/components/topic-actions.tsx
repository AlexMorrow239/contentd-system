import type { TopicRow } from '../../daemon/src/features/topics/types'
import type { JobAction } from '../lib/server/queries/job-content'
import { ActionForm } from './action-form'
import { JobActionGroup } from './job-action-state'

export function TopicActions({
  topic,
  action,
  token,
  disabled,
  icons = false,
}: {
  topic: TopicRow
  action: JobAction | null
  token: string
  disabled: boolean
  icons?: boolean
}) {
  const common = { token, disabled, icon: icons, inPlace: true }
  return (
    <JobActionGroup action={action}>
      {topic.status === 'candidate' && (
        <ActionForm {...common} kind="topics.reject" fields={{ ids: String(topic.id) }} />
      )}
      {topic.status === 'claimed' && (
        <ActionForm {...common} kind="topics.requeue" fields={{ id: String(topic.id) }} />
      )}
      {topic.status !== 'candidate' && topic.status !== 'claimed' && (
        <span className="muted">—</span>
      )}
    </JobActionGroup>
  )
}
