import { describe, expect, it } from 'vitest'
import type { ActionRow } from '../../../actions/queue.js'
import { actionForm, daemonBanner, renderActionsPage, renderConfirmPage } from '../actions.js'

function action(overrides: Partial<ActionRow> = {}): ActionRow {
  return {
    id: 1,
    kind: 'topics.reject',
    lane: 'fast',
    args: '{"ids":[4]}',
    status: 'done',
    requestedBy: 'dashboard',
    createdAt: '2026-08-01T10:00:00.000Z',
    startedAt: '2026-08-01T10:00:01.000Z',
    finishedAt: '2026-08-01T10:00:01.000Z',
    result: '{"rejected":1}',
    error: null,
    errorKind: null,
    notice: null,
    ...overrides,
  }
}

describe('renderActionsPage', () => {
  it('renders each action with its status', () => {
    const out = renderActionsPage(
      { actions: [action()], daemonStale: false, daemonState: null },
      {},
    ).value
    expect(out).toContain('topics.reject')
    expect(out).toContain('done')
  })

  it('shows the error and its kind on a failed action', () => {
    const out = renderActionsPage(
      {
        actions: [action({ status: 'failed', error: 'no such job', errorKind: 'not-found' })],
        daemonStale: false,
        daemonState: null,
      },
      {},
    ).value
    expect(out).toContain('no such job')
    expect(out).toContain('not-found')
  })

  it('shows a running action notice', () => {
    const out = renderActionsPage(
      {
        actions: [action({ status: 'running', notice: 'waiting for the publish lease' })],
        daemonStale: false,
        daemonState: null,
      },
      {},
    ).value
    expect(out).toContain('waiting for the publish lease')
  })

  it('escapes an error message rather than rendering it as markup', () => {
    const out = renderActionsPage(
      {
        actions: [action({ status: 'failed', error: '<script>alert(1)</script>' })],
        daemonStale: false,
        daemonState: null,
      },
      {},
    ).value
    expect(out).not.toContain('<script>alert(1)</script>')
    expect(out).toContain('&lt;script&gt;')
  })

  it('marks the highlighted action', () => {
    const out = renderActionsPage(
      { actions: [action({ id: 9 })], daemonStale: false, daemonState: null },
      { highlightId: 9 },
    ).value
    expect(out).toContain('class="row highlight"')
  })

  it('says so when nothing has been queued yet', () => {
    const out = renderActionsPage({ actions: [], daemonStale: false, daemonState: null }, {}).value
    expect(out).toContain('no operator actions yet')
  })
})

describe('daemonBanner', () => {
  it('warns that queued actions will not run when the daemon is stale', () => {
    expect(daemonBanner(true).value).toContain('daemon not running')
  })

  it('renders nothing when the daemon is live', () => {
    expect(daemonBanner(false).value).toBe('')
  })
})

describe('actionForm', () => {
  it('carries the kind, the token and the return path as hidden fields', () => {
    const out = actionForm({
      kind: 'topics.reject',
      csrfToken: 'tok',
      from: '/topics',
      fields: { ids: '4' },
      label: 'reject',
    }).value
    expect(out).toContain('method="post"')
    expect(out).toContain('action="/actions"')
    expect(out).toContain('name="kind" value="topics.reject"')
    expect(out).toContain('name="csrf" value="tok"')
    expect(out).toContain('name="from" value="/topics"')
    expect(out).toContain('name="ids" value="4"')
  })

  it('links to the interstitial instead of posting when the action needs confirming', () => {
    const out = actionForm({
      kind: 'publish.markDone',
      csrfToken: 'tok',
      from: '/publishes',
      fields: { jobId: 'j1' },
      label: 'mark done',
    }).value
    expect(out).toContain('/actions/confirm?kind=publish.markDone')
    expect(out).not.toContain('method="post"')
  })

  it('disables the control when the daemon is down', () => {
    const out = actionForm({
      kind: 'topics.reject',
      csrfToken: 'tok',
      from: '/topics',
      fields: { ids: '4' },
      label: 'reject',
      disabled: true,
    }).value
    expect(out).toContain('disabled')
  })

  it('renders the confirm-type control as a non-navigable, disabled span when the daemon is down', () => {
    // publish.markDone is the one confirm:true action and the only one
    // reached through the confirm-link path — a stale-daemon guard that
    // forgets this branch leaves the single irreversible action clickable
    // while every other control on the page is disabled.
    const out = actionForm({
      kind: 'publish.markDone',
      csrfToken: 'tok',
      from: '/publishes',
      fields: { jobId: 'j1' },
      label: 'mark done',
      disabled: true,
    }).value
    expect(out).not.toContain('<a ')
    expect(out).not.toContain('/actions/confirm')
    expect(out).toContain('<span')
    expect(out).toContain('aria-disabled="true"')
  })
})

describe('renderConfirmPage', () => {
  it('states the consequence and posts the prefilled args', () => {
    const out = renderConfirmPage({
      kind: 'publish.markDone',
      csrfToken: 'tok',
      from: '/publishes',
      fields: { jobId: 'j1' },
      missing: [],
      daemonStale: false,
    }).value
    expect(out).toContain('cannot be undone')
    expect(out).toContain('name="jobId" value="j1"')
    expect(out).toContain('name="csrf" value="tok"')
    expect(out).toContain('method="post"')
  })

  it('renders a text input for an argument the caller could not supply', () => {
    // publish.markDone needs a postId the operator reads off the platform, so
    // the interstitial doubles as the input form.
    const out = renderConfirmPage({
      kind: 'publish.markDone',
      csrfToken: 'tok',
      from: '/publishes',
      fields: { jobId: 'j1' },
      missing: ['postId'],
      daemonStale: false,
    }).value
    expect(out).toContain('name="postId"')
    expect(out).toContain('type="text"')
  })

  it('escapes hostile characters in field values', () => {
    // Field values come from query parameters (operator-controlled but still
    // untrusted input rendered into the form). The html template must escape
    // them, so a value with quotes and angle brackets does not break out.
    const hostile = 'j1" <script>alert(1)</script>'
    const out = renderConfirmPage({
      kind: 'publish.markDone',
      csrfToken: 'tok',
      from: '/publishes',
      fields: { jobId: hostile },
      missing: [],
      daemonStale: false,
    }).value
    expect(out).not.toContain(hostile)
    expect(out).toContain('&quot;')
    expect(out).toContain('&lt;')
    expect(out).toContain('&gt;')
  })

  it('shows the daemon banner and disables the submit button when the daemon is stale', () => {
    const out = renderConfirmPage({
      kind: 'publish.markDone',
      csrfToken: 'tok',
      from: '/publishes',
      fields: { jobId: 'j1' },
      missing: [],
      daemonStale: true,
    }).value
    expect(out).toContain('daemon not running')
    expect(out).toContain('disabled')
  })
})
