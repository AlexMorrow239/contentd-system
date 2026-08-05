import { html } from '../html.js'
import { layout } from './layout.js'

/**
 * Every whole-page error the server renders. They live here rather than beside
 * their routes because each one is markup and chrome — the status code and the
 * control flow that chooses the page stay in server.ts, which is the part that
 * is actually about routing.
 */

export function actionErrorPage(root: string, message: string): string {
  return layout({
    title: 'action refused',
    root,
    activeNav: 'actions',
    body: html`<h1>action refused</h1>
      <p class="error">${message}</p>
      <p class="muted"><a href="/actions">back to actions</a></p>`,
  })
}

export function missingDbPage(dbPath: string, root: string): string {
  return layout({
    title: 'no database',
    root,
    activeNav: 'overview',
    body: html`<h1>no database at <code>${dbPath}</code></h1>
      <p class="muted">
        The database does not exist. The dashboard never creates it — that is the pipeline's job.
      </p>`,
  })
}

export function corruptDbPage(dbPath: string, root: string, message: string): string {
  return layout({
    title: 'database could not be opened',
    root,
    activeNav: 'overview',
    body: html`<h1>database could not be opened</h1>
      <p class="muted">The database at <code>${dbPath}</code> is present but could not be opened:</p>
      <p class="error">${message}</p>`,
  })
}

export function jobNotFoundPage(root: string, jobId: string): string {
  return layout({
    title: 'job not found',
    root,
    activeNav: 'jobs',
    body: html`<h1>no such job</h1>
      <p class="muted">${jobId} is not in this database.</p>`,
  })
}

export function notFoundPage(root: string, path: string): string {
  return layout({
    title: 'not found',
    root,
    activeNav: 'overview',
    body: html`<h1>not found</h1>
      <p class="muted">no route for ${path}</p>`,
  })
}

/** The onError page. A viewer must never be the thing that is broken. */
export function unhandledErrorPage(root: string, message: string): string {
  return layout({
    title: 'error',
    root,
    activeNav: 'overview',
    body: html`<h1>error</h1>
      <p class="error">${message}</p>`,
  })
}
