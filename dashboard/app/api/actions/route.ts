import { errorMessage } from '../../../../daemon/src/shared/errors'
import { resolveDashboardConfig } from '../../../lib/config'
import { csrfToken } from '../../../lib/runtime'
import { submitAction } from '../../../lib/server/submission'
export const runtime = 'nodejs'
export async function POST(request: Request): Promise<Response> {
  try {
    return await submitAction(request, { config: resolveDashboardConfig(), csrfToken: csrfToken() })
  } catch (error) {
    console.error('dashboard: action request failed', error)
    return Response.json({ error: errorMessage(error) }, { status: 503 })
  }
}
