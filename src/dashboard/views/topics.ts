import type { TopicRow, TopicStatus } from '../../scout/topics.js'
import type { DbChoice } from '../config.js'
import { html, SafeHtml } from '../html.js'
import { formatTime } from './jobs.js'
import { dbHref } from './layout.js'

const TOPIC_STATUSES: TopicStatus[] = ['candidate', 'claimed', 'used', 'rejected']

function option(value: string, selected: string | undefined): SafeHtml {
  return selected === value
    ? html`<option value="${value}" selected>${value}</option>`
    : html`<option value="${value}">${value}</option>`
}

export function topicChannels(topics: TopicRow[]): string[] {
  return [...new Set(topics.map((topic) => topic.channel))].sort()
}

export interface TopicsPageData {
  topics: TopicRow[]
  channels: string[]
  filter: { channel?: string; status?: TopicStatus }
  dbChoice: DbChoice
}

export function renderTopicsPage(data: TopicsPageData): SafeHtml {
  const hiddenDb =
    data.dbChoice === 'dev' ? html`<input type="hidden" name="db" value="dev">` : html``

  const filters = html`<form class="filters" method="get" action="/topics">
    ${hiddenDb}
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
    return html`<h1>topics</h1>
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
        ${topic.jobId === null
          ? html`<span class="muted">—</span>`
          : html`<a href="${dbHref(`/jobs/${topic.jobId}`, data.dbChoice)}">${topic.jobId}</a>`}
      </td>
      <td><a href="${topic.url}" rel="noreferrer">${topic.source}</a></td>
      <td class="muted">${topic.reason}</td>
      <td>${formatTime(topic.createdAt)}</td>
    </tr>`,
  )

  return html`<h1>topics</h1>
    ${filters}
    <table>
      <thead>
        <tr>
          <th>score</th><th>title</th><th>channel</th><th>status</th>
          <th>job</th><th>source</th><th>reason</th><th>found</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>`
}
