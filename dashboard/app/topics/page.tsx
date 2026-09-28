import { countTopics, topicChannels } from '../../lib/server/queries/topics'
import { TOPIC_STATUSES, listTopics } from '../../../src/scout/topics'
import { ActionForm } from '../../components/action-form'
import { DashboardPage, pick, value, type PageProps } from '../../components/page'
import {
  Filters,
  JobLink,
  SafeLink,
  Status,
  Table,
  Truncation,
  formatTime,
} from '../../components/ui'
export default function TopicsPage(props: PageProps) {
  return (
    <DashboardPage {...props}>
      {(db, ctx) => {
        const filter = {
          channel: value(ctx.search, 'channel'),
          status: pick(TOPIC_STATUSES, value(ctx.search, 'status')),
        }
        const topics = listTopics(db, { ...filter, limit: 200 }).sort(
          (a, b) => b.score - a.score || a.id - b.id,
        )
        return (
          <>
            <h1>Topics</h1>
            <p className="subtitle">Scout candidates and the production queue.</p>
            <div className="page-actions">
              <ActionForm kind="scout.run" token={ctx.token} disabled={ctx.stale} />
            </div>
            <Filters
              path="/topics"
              filters={[
                { name: 'channel', values: topicChannels(db), selected: filter.channel },
                { name: 'status', values: TOPIC_STATUSES, selected: filter.status },
              ]}
            />
            <Truncation shown={topics.length} total={countTopics(db, filter)} />
            {topics.length === 0 ? (
              <p className="empty">No topics match these filters.</p>
            ) : (
              <Table
                headings={[
                  'Score',
                  'Title',
                  'Channel',
                  'Status',
                  'Job',
                  'Source',
                  'Reason',
                  'Found',
                  'Actions',
                ]}
              >
                {topics.map((topic) => (
                  <tr key={topic.id}>
                    <td>{topic.score}</td>
                    <td>{topic.title}</td>
                    <td>{topic.channel}</td>
                    <td>
                      <Status value={topic.status} />
                    </td>
                    <td>{topic.jobId ? <JobLink id={topic.jobId} /> : '—'}</td>
                    <td>
                      <SafeLink url={topic.url}>{topic.source}</SafeLink>
                    </td>
                    <td>{topic.reason}</td>
                    <td>{formatTime(topic.createdAt)}</td>
                    <td>
                      {topic.status === 'candidate' && (
                        <ActionForm
                          kind="topics.reject"
                          token={ctx.token}
                          fields={{ ids: String(topic.id) }}
                          disabled={ctx.stale}
                        />
                      )}
                      {topic.status === 'claimed' && (
                        <ActionForm
                          kind="topics.requeue"
                          token={ctx.token}
                          fields={{ id: String(topic.id) }}
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
