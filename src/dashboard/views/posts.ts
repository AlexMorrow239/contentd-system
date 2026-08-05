import { html, safeLink, SafeHtml } from '../html.js'
import type { PostLogEntry } from '../queries/posts.js'
import { formatTime } from './jobs.js'
import { href } from './layout.js'

export interface PostLogPageData {
  entries: PostLogEntry[]
}

function renderUrl(url: string | null): SafeHtml {
  if (url === null) return html`<span class="muted">—</span>`
  return safeLink(url, url)
}

export function renderPostLogPage(data: PostLogPageData): SafeHtml {
  if (data.entries.length === 0) {
    return html`<h1>posts</h1>
      <p class="empty">no posts yet</p>`
  }

  const rows = data.entries.map(
    (entry) => html`<tr>
      <td>${formatTime(entry.postedAt)}</td>
      <td>${entry.channel}</td>
      <td>${entry.platform}</td>
      <td>
        <a href="${href(`/jobs/${entry.jobId}`)}">${entry.topic}</a>
      </td>
      <td>${renderUrl(entry.url)}</td>
    </tr>`,
  )

  return html`<h1>posts</h1>
    <table>
      <thead>
        <tr><th>posted</th><th>channel</th><th>platform</th><th>topic</th><th>link</th></tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>`
}
