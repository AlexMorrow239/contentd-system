import {
  countLibraryEntries,
  libraryChannels,
  listLibraryEntries,
} from '../../lib/server/queries/library'
import { LIBRARY_STATES } from '../../../src/jobs/library'
import { ActionForm } from '../../components/action-form'
import { DashboardPage, pick, value, type PageProps } from '../../components/page'
import {
  Filters,
  JobLink,
  SafeLink,
  Status,
  Table,
  Truncation,
  Video,
  formatTime,
} from '../../components/ui'
export default function LibraryPage(props: PageProps) {
  return (
    <DashboardPage {...props}>
      {(db, ctx) => {
        const filter = {
          channel: value(ctx.search, 'channel'),
          state: pick(LIBRARY_STATES, value(ctx.search, 'state')),
        }
        const entries = listLibraryEntries(db, filter)
        return (
          <>
            <h1>Library</h1>
            <p className="subtitle">Finished videos and quality checks.</p>
            <Filters
              path="/library"
              filters={[
                { name: 'channel', values: libraryChannels(db), selected: filter.channel },
                { name: 'state', values: LIBRARY_STATES, selected: filter.state },
              ]}
            />
            <Truncation shown={entries.length} total={countLibraryEntries(db, filter)} />
            {entries.length === 0 ? (
              <p className="empty">No library entries match these filters.</p>
            ) : (
              <Table
                headings={['Video', 'Job', 'Topic', 'State', 'Live', 'QC', 'Created', 'Actions']}
              >
                {entries.map((entry) => (
                  <tr key={entry.jobId}>
                    <td>
                      <Video bytes={entry.bytes} jobId={entry.jobId} />
                    </td>
                    <td>
                      <JobLink id={entry.jobId} />
                      <p className="muted">{entry.channel}</p>
                    </td>
                    <td>{entry.topic}</td>
                    <td>
                      <Status value={entry.state} />
                    </td>
                    <td>
                      {entry.links.length === 0
                        ? '—'
                        : entry.links.map((link) => (
                            <p key={link.platform}>
                              <SafeLink url={link.url}>{link.platform}</SafeLink>
                            </p>
                          ))}
                    </td>
                    <td>
                      {entry.qc.kind === 'issues' ? (
                        <ul className="error">
                          {entry.qc.issues.map((issue, i) => (
                            <li key={i}>{issue}</li>
                          ))}
                        </ul>
                      ) : entry.qc.kind === 'ok' ? (
                        <Status value="qc ok" />
                      ) : entry.qc.kind === 'unparseable' ? (
                        <span className="warning">Unparseable QC verdict</span>
                      ) : (
                        <span className="muted">No QC verdict</span>
                      )}
                    </td>
                    <td>{formatTime(entry.createdAt)}</td>
                    <td>
                      {entry.state === 'needs-review' && (
                        <ActionForm
                          kind="library.approve"
                          token={ctx.token}
                          fields={{ jobIds: entry.jobId }}
                          disabled={ctx.stale}
                        />
                      )}
                      {entry.state !== 'blocked' && (
                        <ActionForm
                          kind="library.reject"
                          token={ctx.token}
                          fields={{ jobIds: entry.jobId }}
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
