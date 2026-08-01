import type { TopicRow, TopicStatus } from '../../scout/topics.js'
import { html, httpUrlOrNull, SafeHtml } from '../html.js'
import { formatTime, truncationNotice } from './jobs.js'
import { href } from './layout.js'
import { actionForm, daemonBanner } from './actions.js'

const TOPIC_STATUSES: TopicStatus[] = ['candidate', 'claimed', 'used', 'rejected']

function option(value: string, selected: string | undefined): SafeHtml {
  return selected === value
    ? html`<option value="${value}" selected>${value}</option>`
    : html`<option value="${value}">${value}</option>`
}

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
  const filters = html`<form class="filters" method="get" action="/topics">
    <select name="channel">
      <option value="">all channels</option>
      ${data.channels.map((channel) => option(channel, data.filter.channel))}
    </select>
    <select name="status">
      <option value="">all statuses</option>
      ${TOPIC_STATUSES.map((status) => option(status, data.filter.status))}
    </select>
    <button type="submit">filter</button>
  </form>`

  if (data.topics.length === 0) {
    return html`${daemonBanner(data.daemonStale)}
      <h1>topics</h1>
      ${filters}
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
        ${(() => {
          const safeUrl = httpUrlOrNull(topic.url)
          return safeUrl === null
            ? html`<span class="warning" title="blocked unsafe link scheme">${topic.source}</span>`
            : html`<a href="${safeUrl}" rel="noreferrer">${topic.source}</a>`
        })()}
      </td>
      <td class="muted">${topic.reason}</td>
      <td>${formatTime(topic.createdAt)}</td>
      <td>${topicActions(topic, data.csrfToken, data.daemonStale)}</td>
    </tr>`,
  )

  return html`${daemonBanner(data.daemonStale)}
    <h1>topics</h1>
    ${filters}
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
