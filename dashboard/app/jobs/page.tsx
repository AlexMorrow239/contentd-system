import Link from 'next/link'
import { redirect } from 'next/navigation'
import { tryLoadChannelsDir } from '../../../daemon/src/config/channel'
import { countJobs, jobChannels, jobsRefreshSeconds, listJobs } from '../../lib/server/queries/jobs'
import { JOBS_PAGE_SIZE, jobsUrl, parseJobFilters } from '../../lib/shared/job-filters'
import { pageNumber } from '../../lib/shared/filters'
import { formatUsdMicros } from '../../../daemon/src/money'
import { ActionForm } from '../../components/action-form'
import { DashboardPage, type PageProps } from '../../components/page'
import { JobFiltersControl } from '../../components/job-filters'
import { JobActions } from '../../components/job-actions'
import { JobWorkspace } from '../../components/job-action-state'
import { PostingSummary, VideoSummary } from '../../components/job-summary'
import { Pagination, Status, Table, formatTime } from '../../components/ui'

export default function JobsPage(props: PageProps) {
  return (
    <DashboardPage {...props} refreshSeconds={jobsRefreshSeconds} compactActions>
      {(db, ctx) => {
        const filter = parseJobFilters(ctx.search)
        const { channels, error } = tryLoadChannelsDir(ctx.config.paths.channelsDir)
        const total = countJobs(db, filter, channels)
        const requestedPage = pageNumber(ctx.search.page)
        const pageCount = Math.max(1, Math.ceil(total / JOBS_PAGE_SIZE))
        const page = Math.min(requestedPage, pageCount)
        if (page !== requestedPage) redirect(jobsUrl(filter, page))
        const jobs = listJobs(
          db,
          { ...filter, limit: JOBS_PAGE_SIZE, offset: (page - 1) * JOBS_PAGE_SIZE },
          channels,
        )
        const from = jobsUrl(filter, page)
        return (
          <JobWorkspace>
            <div className="jobs-heading">
              <div>
                <h1>Jobs</h1>
                <p className="subtitle">Production, review, and posting at a glance.</p>
              </div>
              <ActionForm kind="produce.next" token={ctx.token} disabled={ctx.stale} />
            </div>
            {error && (
              <p className="warning">
                Channel config error: {error}. Posting progress is unavailable.
              </p>
            )}
            <JobFiltersControl channels={jobChannels(db)} />
            <div className="list-meta">
              <span>
                {total.toLocaleString()} {total === 1 ? 'job' : 'jobs'}
                {total > JOBS_PAGE_SIZE && ` · Page ${page} of ${pageCount}`}
              </span>
              <span>Newest first</span>
            </div>
            {jobs.length === 0 ? (
              <p className="empty">No jobs match these filters.</p>
            ) : (
              <div className="jobs-table">
                <Table
                  headings={[
                    'Job',
                    'Channel',
                    'Status',
                    'Video / review',
                    'Posting',
                    'Created',
                    'Cost',
                    'Actions',
                  ]}
                >
                  {jobs.map((job) => {
                    const href = `/jobs/${encodeURIComponent(job.id)}?from=${encodeURIComponent(from)}`
                    return (
                      <tr key={job.id}>
                        <td className="job-topic">
                          <Link className="job-topic-link" href={href}>
                            {job.topic}
                          </Link>
                          <p className="job-secondary">
                            <Link href={href}>{job.id}</Link>
                          </p>
                        </td>
                        <td>{job.channel}</td>
                        <td>
                          <Status value={job.status} />
                        </td>
                        <td>
                          <VideoSummary video={job.video} />
                        </td>
                        <td>
                          <PostingSummary posting={job.posting} />
                        </td>
                        <td className="job-created">{formatTime(job.createdAt)}</td>
                        <td className="job-cost">{formatUsdMicros(job.costUsdMicros)}</td>
                        <td className="job-actions-cell">
                          <JobActions job={job} token={ctx.token} disabled={ctx.stale} icons />
                        </td>
                      </tr>
                    )
                  })}
                </Table>
              </div>
            )}
            <Pagination
              label="Jobs pages"
              page={page}
              pageCount={pageCount}
              href={(target) => jobsUrl(filter, target)}
            />
          </JobWorkspace>
        )
      }}
    </DashboardPage>
  )
}
