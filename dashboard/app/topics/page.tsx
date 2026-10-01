import { redirect } from 'next/navigation'
import { listTopics } from '../../../daemon/src/features/topics/queries.js'
import { ActionForm } from '../../components/action-form'
import { ListHeading, ListResults, ListTitleCell } from '../../components/list-page'
import { DashboardPage, type PageProps } from '../../components/page'
import { TopicFiltersControl } from '../../components/topic-filters'
import { Status, formatTime } from '../../components/ui'
import { JobWorkspace } from '../../components/job-action-state'
import { TopicActions } from '../../components/topic-actions'
import { TopicSource } from '../../components/topic-source'
import { countTopics, topicChannels, topicActions } from '../../lib/server/queries/topics'
import { pageNumber } from '../../lib/shared/filters'
import { TOPICS_PAGE_SIZE, parseTopicFilters, topicsUrl } from '../../lib/shared/topic-filters'
export default function TopicsPage(props: PageProps) {
  return (
    <DashboardPage {...props} refreshSeconds={3} compactActions>
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
        const actions = topicActions(
          db,
          topics.map((topic) => topic.id),
        )
        const from = topicsUrl(filter, page)
        return (
          <JobWorkspace>
            <ListHeading
              title="Topics"
              subtitle="Scout candidates and the production queue."
              action={<ActionForm kind="scout.run" token={ctx.token} disabled={ctx.stale} />}
            />
            <TopicFiltersControl channels={topicChannels(db)} />
            <ListResults
              summary={
                <>
                  {total.toLocaleString()} {total === 1 ? 'topic' : 'topics'}
                </>
              }
              order="Highest score first"
              empty={topics.length === 0}
              emptyMessage="No topics match these filters."
              headings={[
                'Topic',
                'Score',
                'Channel',
                'Status',
                'Source material',
                'Found',
                'Actions',
              ]}
              pagination={{
                label: 'Topics pages',
                page,
                pageCount,
                href: (target) => topicsUrl(filter, target),
              }}
            >
              {topics.map((topic) => (
                <tr key={topic.id}>
                  <ListTitleCell
                    href={`/topics/${topic.id}?from=${encodeURIComponent(from)}`}
                    title={topic.title}
                  >
                    Topic #{topic.id} · {topic.source}
                  </ListTitleCell>
                  <td>{topic.score}/100</td>
                  <td>{topic.channel}</td>
                  <td>
                    <Status value={topic.status} />
                  </td>
                  <td>
                    <TopicSource topic={topic} />
                  </td>
                  <td className="job-created">{formatTime(topic.createdAt)}</td>
                  <td className="job-actions-cell">
                    <TopicActions
                      topic={topic}
                      action={actions.get(topic.id) ?? null}
                      token={ctx.token}
                      disabled={ctx.stale}
                      icons
                    />
                  </td>
                </tr>
              ))}
            </ListResults>
          </JobWorkspace>
        )
      }}
    </DashboardPage>
  )
}
