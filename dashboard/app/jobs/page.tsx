import Link from 'next/link'
import { redirect } from 'next/navigation'
import { tryLoadChannelsDir } from '../../../daemon/src/config/channel'
import { formatUsdMicros } from '../../../daemon/src/shared/money'
import { ActionForm } from '../../components/action-form'
import { JobWorkspace } from '../../components/job-action-state'
import { JobActions } from '../../components/job-actions'
import { JobFiltersControl } from '../../components/job-filters'
import { PostingSummary, VideoSummary } from '../../components/job-summary'
import { ListHeading, ListResults, ListTitleCell } from '../../components/list-page'
import { DashboardPage, type PageProps } from '../../components/page'
import { Status, formatTime } from '../../components/ui'
import { countJobs, jobChannels, jobsRefreshSeconds, listJobs } from '../../lib/server/queries/jobs'
import { pageNumber } from '../../lib/shared/filters'
import { JOBS_PAGE_SIZE, jobsUrl, parseJobFilters } from '../../lib/shared/job-filters'

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
            <ListHeading
              title="Jobs"
              subtitle="Production, review, and posting at a glance."
              action={<ActionForm kind="produce.next" token={ctx.token} disabled={ctx.stale} />}
            />
            {error && (
              <p className="warning">
                Channel config error: {error}. Posting progress is unavailable.
              </p>
            )}
            <JobFiltersControl channels={jobChannels(db)} />
            <ListResults
              summary={
                <>
                  {total.toLocaleString()} {total === 1 ? 'job' : 'jobs'}
                  {total > JOBS_PAGE_SIZE && ` · Page ${page} of ${pageCount}`}
                </>
              }
              order="Newest first"
              empty={jobs.length === 0}
              emptyMessage="No jobs match these filters."
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
              pagination={{
                label: 'Jobs pages',
                page,
                pageCount,
                href: (target) => jobsUrl(filter, target),
              }}
            >
              {jobs.map((job) => {
                const href = `/jobs/${encodeURIComponent(job.id)}?from=${encodeURIComponent(from)}`
                return (
                  <tr key={job.id}>
                    <ListTitleCell href={href} title={job.topic}>
                      <Link href={href}>{job.id}</Link>
                    </ListTitleCell>
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
            </ListResults>
          </JobWorkspace>
        )
      }}
    </DashboardPage>
  )
}
