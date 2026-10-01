import { redirect } from 'next/navigation'
import { listTopics } from '../../../daemon/src/features/topics/queries.js'
import { ActionForm } from '../../components/action-form'
import { DashboardPage, type PageProps } from '../../components/page'
import { TopicFiltersControl } from '../../components/topic-filters'
import { JobLink, Pagination, SafeLink, Status, Table, formatTime } from '../../components/ui'
import { countTopics, topicChannels } from '../../lib/server/queries/topics'
import { pageNumber } from '../../lib/shared/filters'
import { TOPICS_PAGE_SIZE, parseTopicFilters, topicsUrl } from '../../lib/shared/topic-filters'
export default function TopicsPage(props: PageProps) {
  return (
    <DashboardPage {...props}>
      {(db, ctx) => {
        const filter = parseTopicFilters(ctx.search)
        const total = countTopics(db, filter)
        const requestedPage = pageNumber(ctx.search.page)
        const pageCount = Math.max(1, Math.ceil(total / TOPICS_PAGE_SIZE))
        const page = Math.min(requestedPage, pageCount)
        if (page !== requestedPage) redirect(topicsUrl(filter, page))
        const topics = listTopics(db, {
          ...filter,
          order: 'score',
          limit: TOPICS_PAGE_SIZE,
          offset: (page - 1) * TOPICS_PAGE_SIZE,
        })
        return (
          <>
            <h1>Topics</h1>
            <p className="subtitle">Scout candidates and the production queue.</p>
            <div className="page-actions">
              <ActionForm kind="scout.run" token={ctx.token} disabled={ctx.stale} />
            </div>
            <TopicFiltersControl channels={topicChannels(db)} />
            <div className="list-meta">
              <span>
                {total.toLocaleString()} {total === 1 ? 'topic' : 'topics'}
              </span>
              <span>Highest score first</span>
            </div>
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
                    <td>
                      <span>{topic.title}</span>
                      <p className="job-secondary">Topic #{topic.id}</p>
                    </td>
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
            <Pagination
              label="Topics pages"
              page={page}
              pageCount={pageCount}
              href={(target) => topicsUrl(filter, target)}
            />
          </>
        )
      }}
    </DashboardPage>
  )
}
