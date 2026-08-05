import { html, SafeHtml } from '../html.js'
import type { LibraryBytes } from '../queries/library.js'
import { href } from './layout.js'

/**
 * The one rendering of "where this video's bytes are". Three pages drew the
 * same four states — /library, /post and the job drill-in — and the player
 * markup had already been copied three times. The dashboard holds no bucket
 * credentials by design, so every state except 'local' is a label, not a
 * playable source.
 *
 * The two states whose wording is genuinely page-specific ('archived' and
 * 'reclaimed' each mean something the reader wants said differently on a
 * discard queue than on a posting queue) take their text as a parameter;
 * 'local' and 'unstored' are identical everywhere and are owned here.
 */
export function bytesCell(
  bytes: LibraryBytes,
  jobId: string,
  notes?: { archived?: string; reclaimed?: string },
): SafeHtml {
  switch (bytes) {
    case 'local':
      return html`<video controls preload="metadata" src="${href(`/library/${jobId}/video`)}"></video>`
    case 'archived':
      return html`<span class="muted">${notes?.archived ?? 'archived to object storage'}</span>`
    case 'reclaimed':
      return html`<span class="muted">${notes?.reclaimed ?? 'reclaimed'}</span>`
    case 'unstored':
      return html`<span class="muted">not stored — run <code>library backfill-store</code></span>`
  }
}
