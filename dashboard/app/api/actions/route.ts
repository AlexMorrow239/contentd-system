import { submitAction } from '../../../lib/server/submission'
import { resolveDashboardConfig } from '../../../lib/config'
import { errorMessage } from '../../../../src/errors'
import { csrfToken } from '../../../lib/runtime'
export const runtime = 'nodejs'
export async function POST(request: Request): Promise<Response> {
  try {
    return await submitAction(request, { config: resolveDashboardConfig(), csrfToken: csrfToken() })
  } catch (error) {
    console.error('dashboard: action request failed', error)
    return Response.json({ error: errorMessage(error) }, { status: 503 })
  }
}
