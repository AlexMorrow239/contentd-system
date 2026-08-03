import type { PostCard, PostCardPlatform } from '../queries/post.js'
import { html, httpUrlOrNull, SafeHtml } from '../html.js'
import { formatTime } from './jobs.js'
import { href } from './layout.js'
import { actionForm, daemonBanner } from './actions.js'

export interface PostPageData {
  cards: PostCard[]
  csrfToken: string
  daemonStale: boolean
  /** A channels-directory load error, surfaced without hiding whatever the page can still show. */
  configError?: string
}

function seriesBadge(label: string | null): SafeHtml {
  return label === null ? html`` : html`<span class="badge series">${label}</span>`
}

/**
 * The dashboard holds no bucket credentials by design, so 'archived',
 * 'reclaimed' and 'unstored' each render a plain label instead of a player —
 * the same four states /library draws, reused here rather than reinvented.
 */
function renderBytes(card: PostCard): SafeHtml {
  switch (card.bytes) {
    case 'local':
      return html`<video controls preload="metadata" src="${href(`/library/${card.jobId}/video`)}"></video>`
    case 'archived':
      return html`<span class="muted">archived to object storage</span>`
    case 'reclaimed':
      return html`<span class="muted">reclaimed — already posted everywhere it was going</span>`
    case 'unstored':
      return html`<span class="muted">not stored — run <code>library backfill-store</code></span>`
  }
}

/** One paste block: a readonly textarea (never <pre> — selecting 2200 chars by hand is miserable)
 * plus a copy button that degrades to manual selection when clipboard access is unavailable. */
function pasteField(label: string, value: string, rows: number): SafeHtml {
  return html`<label class="field">${label}
    <div class="copy-row">
      <textarea readonly rows="${String(rows)}">${value}</textarea>
      <button type="button" class="copy-btn" data-copy-target>copy</button>
    </div>
  </label>`
}

function markForm(
  jobId: string,
  p: PostCardPlatform,
  csrfToken: string,
  from: string,
  disabled: boolean,
): SafeHtml {
  return html`<form class="action post-mark" method="post" action="/actions">
    <input type="hidden" name="kind" value="post.mark">
    <input type="hidden" name="csrf" value="${csrfToken}">
    <input type="hidden" name="from" value="${from}">
    <input type="hidden" name="jobId" value="${jobId}">
    <input type="hidden" name="platform" value="${p.platform}">
    <label class="field">link
      <input type="url" name="url" placeholder="paste the live link (optional)" autocomplete="off">
    </label>
    <button class="action-button" type="submit" ${disabled ? new SafeHtml('disabled') : ''}>mark posted</button>
  </form>`
}

function postedBlock(
  jobId: string,
  p: PostCardPlatform,
  csrfToken: string,
  from: string,
  disabled: boolean,
): SafeHtml {
  const safeUrl = p.url === null ? null : httpUrlOrNull(p.url)
  const link =
    p.url === null
      ? html`<p class="muted">no link saved</p>`
      : safeUrl === null
        ? html`<span class="warning" title="blocked unsafe link scheme">${p.url}</span>`
        : html`<p><a href="${safeUrl}" rel="noreferrer noopener" target="_blank">${p.url}</a></p>`
  return html`<div class="post-platform posted">
    <h3>${p.platform} — posted</h3>
    ${link}
    ${actionForm({
      kind: 'post.unmark',
      csrfToken,
      from,
      fields: { jobId, platform: p.platform },
      disabled,
      subtle: true,
    })}
  </div>`
}

function platformBlock(
  jobId: string,
  p: PostCardPlatform,
  csrfToken: string,
  from: string,
  disabled: boolean,
): SafeHtml {
  if (p.posted) return postedBlock(jobId, p, csrfToken, from, disabled)

  const title = p.title === null ? html`` : pasteField('title', p.title, 2)
  const tags = p.tags === null ? html`` : pasteField('tags', p.tags, 2)
  const bodyLabel = p.title === null ? 'caption' : 'description'

  return html`<div class="post-platform">
    <h3>${p.platform}</h3>
    ${title}
    ${pasteField(bodyLabel, p.body, 6)}
    ${tags}
    ${markForm(jobId, p, csrfToken, from, disabled)}
  </div>`
}

function renderCard(card: PostCard, csrfToken: string, daemonStale: boolean): SafeHtml {
  const from = '/post'
  return html`<article class="post-card">
    <header>
      <h2>${card.topic} ${seriesBadge(card.seriesLabel)}</h2>
      <p class="muted">
        ${card.channel} · <a href="${href(`/jobs/${card.jobId}`)}">${card.jobId}</a> ·
        ${formatTime(card.createdAt)}
      </p>
    </header>
    ${renderBytes(card)}
    <div class="post-platforms">
      ${card.platforms.map((p) => platformBlock(card.jobId, p, csrfToken, from, daemonStale))}
    </div>
    <footer class="post-card-footer">
      ${actionForm({
        kind: 'library.reject',
        csrfToken,
        from,
        fields: { jobIds: card.jobId },
        disabled: daemonStale,
        subtle: true,
      })}
    </footer>
  </article>`
}

// Tiny inline script, no external dependency: clipboard access can be absent
// (insecure context, permission denial), in which case the button simply does
// nothing and the operator falls back to selecting the textarea by hand.
const copyScript = html`<script>
document.querySelectorAll('[data-copy-target]').forEach((btn) => {
  btn.addEventListener('click', () => {
    const field = btn.previousElementSibling
    if (field && navigator.clipboard) {
      navigator.clipboard.writeText(field.value).catch(() => {})
    }
  })
})
</script>`

export function renderPostQueuePage(data: PostPageData): SafeHtml {
  const banner =
    data.configError === undefined
      ? html``
      : html`<p class="warning">channel config error: ${data.configError}</p>`

  if (data.cards.length === 0) {
    return html`${daemonBanner(data.daemonStale)}
      <h1>post</h1>
      ${banner}
      <p class="empty">nothing waiting to post</p>`
  }

  return html`${daemonBanner(data.daemonStale)}
    <h1>post</h1>
    ${banner}
    <div class="post-queue">
      ${data.cards.map((c) => renderCard(c, data.csrfToken, data.daemonStale))}
    </div>
    ${copyScript}`
}
