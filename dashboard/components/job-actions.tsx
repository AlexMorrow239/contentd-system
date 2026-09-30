import type { JobListRow } from '../lib/server/queries/jobs'
import { ActionForm } from './action-form'
import { JobActionGroup } from './job-action-state'

export function JobActions({
  job,
  token,
  disabled,
  icons = false,
}: {
  job: JobListRow
  token: string
  disabled: boolean
  icons?: boolean
}) {
  const common = {
    token,
    disabled,
    icon: icons,
    inPlace: true,
    confirmation: 'modal' as const,
    subject: job.topic,
  }
  return (
    <JobActionGroup action={job.action}>
      {['failed', 'blocked'].includes(job.status) && (
        <ActionForm {...common} kind="jobs.resume" fields={{ jobId: job.id }} />
      )}
      {job.video?.state === 'needs-review' && (
        <ActionForm {...common} kind="library.approve" fields={{ jobIds: job.id }} />
      )}
      {job.status !== 'running' && (
        <ActionForm {...common} kind="jobs.delete" fields={{ jobId: job.id }} />
      )}
    </JobActionGroup>
  )
}
