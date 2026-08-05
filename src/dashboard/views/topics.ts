import { TOPIC_STATUSES, type TopicRow, type TopicStatus } from '../../scout/topics.js'
import { html, safeLink, SafeHtml } from '../html.js'
import { filterForm } from './filters.js'
import { formatTime, truncationNotice } from './jobs.js'
import { href } from './layout.js'
import { actionForm, daemonBanner, pageActions } from './actions.js'

export interface TopicsPageData {
  topics: TopicRow[]
  /** Total rows matching the filter, before the 200-row cap. Undefined skips the notice. */
  total?: number
  channels: string[]
  filter: { channel?: string; status?: TopicStatus }
  csrfToken: string
  daemonStale: boolean
}

function topicActions(
  row: { id: number; status: string },
  csrfToken: string,
  daemonStale: boolean,
): SafeHtml {
  if (row.status === 'candidate') {
    return actionForm({
      kind: 'topics.reject',
      csrfToken,
      from: '/topics',
      fields: { ids: String(row.id) },
      disabled: daemonStale,
    })
  }
  if (row.status === 'claimed') {
    return actionForm({
      kind: 'topics.requeue',
      csrfToken,
      from: '/topics',
      fields: { id: String(row.id) },
      disabled: daemonStale,
    })
  }
  // used / rejected are terminal: nothing to offer.
  return html``
}

export function renderTopicsPage(data: TopicsPageData): SafeHtml {
  const filters = filterForm('/topics', [
    {
      name: 'channel',
      allLabel: 'all channels',
      values: data.channels,
      selected: data.filter.channel,
    },
    {
      name: 'status',
      allLabel: 'all statuses',
      values: TOPIC_STATUSES,
      selected: data.filter.status,
    },
  ])

  const controls = pageActions([
    actionForm({
      kind: 'scout.run',
      csrfToken: data.csrfToken,
      from: '/topics',
      fields: {},
      disabled: data.daemonStale,
    }),
    actionForm({
      kind: 'topics.pruneMedia',
      csrfToken: data.csrfToken,
      from: '/topics',
      fields: {},
      disabled: data.daemonStale,
      subtle: true,
    }),
  ])

  if (data.topics.length === 0) {
    return html`${daemonBanner(data.daemonStale)}
      <h1>topics</h1>
      ${filters}
      ${controls}
      <p class="empty">no topics match these filters</p>`
  }

  // listTopics orders by recency; the queue is read by score.
  const sorted = [...data.topics].sort((a, b) => b.score - a.score || a.id - b.id)

  const rows = sorted.map(
    (topic) => html`<tr>
      <td>${String(topic.score)}</td>
      <td>${topic.title}</td>
      <td>${topic.channel}</td>
      <td class="status-${topic.status}">${topic.status}</td>
      <td>
        ${
          topic.jobId === null
            ? html`<span class="muted">—</span>`
            : html`<a href="${href(`/jobs/${topic.jobId}`)}">${topic.jobId}</a>`
        }
      </td>
      <td>
        ${safeLink(topic.url, topic.source)}
      </td>
      <td class="muted">${topic.reason}</td>
      <td>${formatTime(topic.createdAt)}</td>
      <td>${topicActions(topic, data.csrfToken, data.daemonStale)}</td>
    </tr>`,
  )

  return html`${daemonBanner(data.daemonStale)}
    <h1>topics</h1>
    ${filters}
    ${controls}
    ${truncationNotice(data.topics.length, data.total)}
    <table>
      <thead>
        <tr>
          <th>score</th><th>title</th><th>channel</th><th>status</th>
          <th>job</th><th>source</th><th>reason</th><th>found</th><th></th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>`
}
