import { JOB_STATUSES, countJobs, jobChannels, listJobs } from '../../lib/server/queries/jobs'
import { formatUsdMicros } from '../../../daemon/src/money'
import { ActionForm } from '../../components/action-form'
import { DashboardPage, pick, value, type PageProps } from '../../components/page'
import {
  Filters,
  JobLink,
  Status,
  Table,
  Truncation,
  formatDuration,
  formatTime,
} from '../../components/ui'
export default function JobsPage(props: PageProps) {
  return (
    <DashboardPage {...props}>
      {(db, ctx) => {
        const filter = {
          channel: value(ctx.search, 'channel'),
          status: pick(JOB_STATUSES, value(ctx.search, 'status')),
        }
        const jobs = listJobs(db, filter)
        return (
          <>
            <h1>Jobs</h1>
            <p className="subtitle">Production progress, costs, and recovery.</p>
            <div className="page-actions">
              <ActionForm kind="produce.next" token={ctx.token} disabled={ctx.stale} />
            </div>
            <Filters
              path="/jobs"
              filters={[
                { name: 'channel', values: jobChannels(db), selected: filter.channel },
                { name: 'status', values: JOB_STATUSES, selected: filter.status },
              ]}
            />
            <Truncation shown={jobs.length} total={countJobs(db, filter)} />
            {jobs.length === 0 ? (
              <p className="empty">No jobs match these filters.</p>
            ) : (
              <Table
                headings={[
                  'Job',
                  'Channel',
                  'Tier',
                  'Topic',
                  'Status',
                  'Created',
                  'Elapsed',
                  'Cost',
                  'Actions',
                ]}
              >
                {jobs.map((job) => (
                  <tr key={job.id}>
                    <td>
                      <JobLink id={job.id} />
                    </td>
                    <td>{job.channel}</td>
                    <td>{job.tier}</td>
                    <td>{job.topic}</td>
                    <td>
                      <Status value={job.status} />
                    </td>
                    <td>{formatTime(job.createdAt)}</td>
                    <td>{formatDuration(job.createdAt, job.finishedAt)}</td>
                    <td>{formatUsdMicros(job.costUsdMicros)}</td>
                    <td>
                      {job.status !== 'running' && (
                        <ActionForm
                          kind="jobs.delete"
                          token={ctx.token}
                          fields={{ jobId: job.id }}
                          disabled={ctx.stale}
                        />
                      )}
                    </td>
                  </tr>
                ))}
              </Table>
            )}
          </>
        )
      }}
    </DashboardPage>
  )
}
