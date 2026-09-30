import { notFound, redirect } from 'next/navigation'
import Link from 'next/link'
import { tryLoadChannelsDir } from '../../../../daemon/src/config/channel'
import { sameSitePath } from '../../../lib/shared/navigation'
import { REVIEW_LABELS } from '../../../lib/shared/job-filters'
import { JobActions } from '../../../components/job-actions'
import { JobWorkspace } from '../../../components/job-action-state'
import { QcResult, PostingSummary } from '../../../components/job-summary'
import { getJobDetail, jobsRefreshSeconds } from '../../../lib/server/queries/jobs'
import { formatUsdMicros } from '../../../../daemon/src/money'
import { DashboardPage, value, type PageProps } from '../../../components/page'
import { SafeLink, Status, Table, Video, formatDuration, formatTime } from '../../../components/ui'
export default async function JobPage(props: PageProps & { params: Promise<{ id: string }> }) {
  const { id } = await props.params
  return (
    <DashboardPage {...props} refreshSeconds={jobsRefreshSeconds} compactActions>
      {(db, ctx) => {
        const candidate = sameSitePath(value(ctx.search, 'from') ?? '')
        const back =
          candidate && new URL(candidate, 'http://dashboard.invalid').pathname === '/jobs'
            ? candidate
            : '/jobs'
        const { channels, error } = tryLoadChannelsDir(ctx.config.paths.channelsDir)
        const detail = getJobDetail(db, id, channels)
        if (detail === null) {
          if (db.prepare('SELECT 1 FROM jobs WHERE id=? AND deleted_at IS NOT NULL').get(id))
            redirect(back)
          notFound()
        }
        const { job } = detail
        return (
          <JobWorkspace>
            <Link className="back-link" href={back}>
              Back to jobs
            </Link>
            <h1>Job {job.id}</h1>
            {error && (
              <p className="warning">
                Channel config error: {error}. Posting progress is unavailable.
              </p>
            )}
            <div className="page-actions">
              <JobActions job={job} token={ctx.token} disabled={ctx.stale} />
            </div>
            <section className="panel">
              <h2>{job.topic}</h2>
              <dl className="facts">
                <dt>Channel</dt>
                <dd>{job.channel}</dd>
                <dt>Tier</dt>
                <dd>{job.tier}</dd>
                <dt>Status</dt>
                <dd>
                  <Status value={job.status} />
                </dd>
                <dt>Created</dt>
                <dd>{formatTime(job.createdAt)}</dd>
                <dt>Finished</dt>
                <dd>{formatTime(job.finishedAt)}</dd>
                <dt>Total spend</dt>
                <dd>{formatUsdMicros(job.costUsdMicros)}</dd>
                <dt>Video review</dt>
                <dd>{REVIEW_LABELS[job.video?.state ?? 'none']}</dd>
                <dt>Posting</dt>
                <dd>
                  <PostingSummary posting={job.posting} />
                </dd>
                <dt>Artifacts</dt>
                <dd>
                  <code>
                    {ctx.config.paths.runsRoot}/{job.id}/
                  </code>
                </dd>
              </dl>
            </section>
            {detail.budgetWait && (
              <section className="panel">
                <h2>Budget wait</h2>
                <p>{detail.budgetWait.reason}</p>
                <dl className="facts">
                  <dt>Stage</dt>
                  <dd>{detail.budgetWait.stage}</dd>
                  {detail.budgetWait.details && (
                    <>
                      <dt>Next call estimate</dt>
                      <dd>{formatUsdMicros(detail.budgetWait.details.upcomingUsdMicros)}</dd>
                      <dt>Recorded spend / cap</dt>
                      <dd>
                        {formatUsdMicros(detail.budgetWait.details.spentUsdMicros)} /{' '}
                        {formatUsdMicros(detail.budgetWait.details.capUsdMicros)} (
                        {detail.budgetWait.details.scope}, {detail.budgetWait.utcDay} UTC)
                      </dd>
                    </>
                  )}
                </dl>
                <p>The next call is checked against current budgets before production resumes.</p>
              </section>
            )}
            {detail.retryAfter && (
              <p>Next eligibility check no earlier than {formatTime(detail.retryAfter)}.</p>
            )}
            {job.video && (
              <section className="panel">
                <h2>Video</h2>
                <Video bytes={job.video.bytes} jobId={job.id} />
                <p className="muted">Created {formatTime(job.video.createdAt)}</p>
                <h3>Quality checks</h3>
                <QcResult qc={job.video.qc} />
                <p>
                  <Link href="/post">Open manual posting queue</Link>
                </p>
              </section>
            )}
            <section className="panel">
              <h2>Posting history</h2>
              {detail.posts.length === 0 ? (
                <p className="empty">No posts yet.</p>
              ) : (
                <Table headings={['Platform', 'Posted', 'Link']}>
                  {detail.posts.map((post) => (
                    <tr key={post.platform}>
                      <td>{post.platform}</td>
                      <td>{formatTime(post.postedAt)}</td>
                      <td>
                        <SafeLink url={post.url}>{post.url ?? 'No link saved'}</SafeLink>
                      </td>
                    </tr>
                  ))}
                </Table>
              )}
            </section>
            <section className="panel">
              <h2>Stages</h2>
              <Table headings={['Stage', 'Status', 'Duration', 'Started / error']}>
                {detail.stages.map((stage) => (
                  <tr key={stage.stage}>
                    <td>{stage.stage}</td>
                    <td>
                      <Status value={stage.status} />
                    </td>
                    <td>{formatDuration(stage.startedAt, stage.finishedAt)}</td>
                    <td>
                      {formatTime(stage.startedAt)}
                      {stage.error && <p className="error">{stage.error}</p>}
                    </td>
                  </tr>
                ))}
              </Table>
            </section>
            <section className="panel">
              <h2>Spend</h2>
              {detail.costs.length === 0 ? (
                <p className="empty">No ledgered spend.</p>
              ) : (
                <Table headings={['Provider', 'Operation', 'Cost', 'At']}>
                  {detail.costs.map((cost, i) => (
                    <tr key={i}>
                      <td>{cost.provider}</td>
                      <td>{cost.operation}</td>
                      <td>{formatUsdMicros(cost.usdMicros)}</td>
                      <td>{formatTime(cost.createdAt)}</td>
                    </tr>
                  ))}
                </Table>
              )}
            </section>
          </JobWorkspace>
        )
      }}
    </DashboardPage>
  )
}
