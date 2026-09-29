import { notFound } from 'next/navigation'
import { getJobDetail } from '../../../lib/server/queries/jobs'
import { formatUsdMicros } from '../../../../daemon/src/money'
import { DashboardPage, type PageProps } from '../../../components/page'
import { SafeLink, Status, Table, Video, formatDuration, formatTime } from '../../../components/ui'
export default async function JobPage(props: PageProps & { params: Promise<{ id: string }> }) {
  const { id } = await props.params
  return (
    <DashboardPage {...props}>
      {(db, ctx) => {
        const detail = getJobDetail(db, id)
        if (detail === null) notFound()
        const { job } = detail
        return (
          <>
            <h1>Job {job.id}</h1>
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
                <dt>Library</dt>
                <dd>{detail.libraryState ?? 'Not in library'}</dd>
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
            {detail.bytes && (
              <section className="panel">
                <h2>Video</h2>
                <Video bytes={detail.bytes} jobId={job.id} />
                {detail.links.map((link) => (
                  <p key={link.platform}>
                    <SafeLink url={link.url}>{link.platform}</SafeLink>
                  </p>
                ))}
              </section>
            )}
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
            <a href="/jobs">← All jobs</a>
          </>
        )
      }}
    </DashboardPage>
  )
}
