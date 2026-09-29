import { openDbActions } from '../../../daemon/src/db/dashboard.js'
import { enqueueAction } from '../../../daemon/src/actions/queue.js'
import { formToArgs, isActionKind, parseActionArgs } from '../../../daemon/src/actions/catalog.js'
import { errorMessage } from '../../../daemon/src/errors.js'
import type { DashboardConfig } from '../config.js'
import { CSRF_FIELD, CSRF_HEADER, csrfFailure } from '../csrf.js'
import { daemonStaleFor, withDashboardDb } from './runtime.js'

export interface SubmissionDeps {
  config: DashboardConfig
  csrfToken: string
  now?: () => Date
}

function failure(status: number, error: string): Response {
  return Response.json({ error }, { status, headers: { 'cache-control': 'no-store' } })
}

/** Validate and enqueue only. Worker execution never belongs to the HTTP process. */
export async function submitAction(request: Request, deps: SubmissionDeps): Promise<Response> {
  let form: FormData
  try {
    form = await request.formData()
  } catch (error) {
    return failure(400, `Could not read the submitted form: ${errorMessage(error)}`)
  }
  const entries: [string, string][] = []
  for (const [key, value] of form.entries()) {
    if (typeof value === 'string') entries.push([key, value])
  }
  const fields = formToArgs(entries)
  // The form carries the token as a field; csrfFailure reads it as a header.
  const formToken = typeof fields[CSRF_FIELD] === 'string' ? fields[CSRF_FIELD] : ''
  const refusal = csrfFailure(
    {
      header: (name) =>
        name.toLowerCase() === CSRF_HEADER ? formToken : (request.headers.get(name) ?? undefined),
    },
    deps.csrfToken,
  )
  if (!deps.csrfToken || refusal !== null)
    return failure(403, refusal ?? 'Missing server token; reload the page.')
  const kind = typeof fields.kind === 'string' ? fields.kind : ''
  if (!isActionKind(kind)) return failure(400, `Unknown action ${JSON.stringify(kind)}`)
  const transport = new Set(['kind', CSRF_FIELD])
  let args: unknown
  try {
    args = parseActionArgs(
      kind,
      Object.fromEntries(Object.entries(fields).filter(([key]) => !transport.has(key))),
    )
  } catch (error) {
    return failure(400, errorMessage(error))
  }
  let stale: boolean
  try {
    stale = withDashboardDb(deps.config.paths.dbPath, (db) =>
      daemonStaleFor(db, deps.now?.() ?? new Date()),
    )
  } catch {
    stale = true
  }
  if (stale)
    return failure(
      409,
      'Daemon not running — nothing was queued. Restart the daemon and try again.',
    )
  try {
    const db = openDbActions(deps.config.paths.dbPath)
    try {
      const actionId = enqueueAction(db, { kind, args, requestedBy: 'dashboard' })
      return Response.json({ actionId }, { status: 202, headers: { 'cache-control': 'no-store' } })
    } finally {
      db.close()
    }
  } catch (error) {
    return failure(503, `Could not queue the action: ${errorMessage(error)}`)
  }
}
