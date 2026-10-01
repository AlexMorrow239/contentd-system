import { tryLoadChannelsDir } from '../../daemon/src/config/channel'
import { formatUsdMicros } from '../../daemon/src/shared/money'
import { ActionForm } from '../components/action-form'
import { Counts, Spend } from '../components/overview'
import { DashboardPage, type PageProps } from '../components/page'
import { JobLink, Status, Table, formatTime } from '../components/ui'
import { buildOverview } from '../lib/server/queries/overview'
export default function OverviewPage(props: PageProps) {
  return (
    <DashboardPage {...props} refreshSeconds={30}>
      {(db, ctx) => {
        const { channels, error } = tryLoadChannelsDir(ctx.config.paths.channelsDir)
        const data = buildOverview(db, channels, new Date())
        return (
          <>
            <h1>Overview</h1>
            <p className="subtitle">Production health at a glance.</p>
            {error && <p className="warning">Channel config error: {error}</p>}
            <div className="page-actions">
              <ActionForm kind="digest.run" token={ctx.token} disabled={ctx.stale} />
            </div>
            <div className="grid">
              <section className="panel">
                <h2>Jobs</h2>
                <Counts counts={data.jobsByStatus} />
                <p className="muted">{data.jobsLast24h} created in the last 24h</p>
              </section>
              <section className="panel">
                <h2>Library</h2>
                <Counts counts={data.libraryByState} />
              </section>
              <section className="panel">
                <h2>Today’s spend (UTC day)</h2>
                <p className="muted">Includes estimated usage costs.</p>
                <table>
                  <tbody>
                    <Spend label="Global" spend={data.globalSpend} />
                    {data.channelSpend.map((spend) => (
                      <Spend key={spend.channel} label={spend.channel} spend={spend} />
                    ))}
                    {data.unattributedUsdMicros > 0 && (
                      <tr>
                        <th>Unattributed</th>
                        <td>
                          {formatUsdMicros(data.unattributedUsdMicros)} — costs without a configured
                          channel
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </section>
            </div>
            <section className="panel">
              <h2>Needs attention</h2>
              {data.attention.length === 0 ? (
                <p className="empty">Nothing failed or blocked.</p>
              ) : (
                <Table headings={['Job', 'Channel', 'Topic', 'Status', 'Stage / error']}>
                  {data.attention.map((job) => (
                    <tr key={job.id}>
                      <td>
                        <JobLink id={job.id} />
                      </td>
                      <td>{job.channel}</td>
                      <td>{job.topic}</td>
                      <td>
                        <Status value={job.status} />
                        {job.status === 'blocked' && (
                          <p className="muted">Budget enforcement, not a crash</p>
                        )}
                      </td>
                      <td>
                        {job.stage ?? '—'}
                        {job.error && <p className="error">{job.error}</p>}
                      </td>
                    </tr>
                  ))}
                </Table>
              )}
            </section>
            <section className="panel">
              <h2>Leases</h2>
              {data.leases.length === 0 ? (
                <p className="empty">No leases held.</p>
              ) : (
                <Table headings={['Lease', 'Holder', 'Expires']}>
                  {data.leases.map((lease) => (
                    <tr key={lease.name}>
                      <td>{lease.name}</td>
                      <td>{lease.holder}</td>
                      <td>
                        {formatTime(lease.expiresAt)}
                        {lease.expired && <span className="error"> Expired</span>}
                      </td>
                    </tr>
                  ))}
                </Table>
              )}
            </section>
          </>
        )
      }}
    </DashboardPage>
  )
}
