import { resolveDashboardConfig } from '../../../../lib/config'
import { withDashboardDb } from '../../../../lib/server/runtime'
import { streamVideo } from '../../../../lib/server/stream-video'
import { errorMessage } from '../../../../../daemon/src/errors'
export const runtime = 'nodejs'
export async function GET(
  request: Request,
  { params }: { params: Promise<{ jobId: string }> },
): Promise<Response> {
  const { jobId } = await params
  try {
    const config = resolveDashboardConfig()
    return withDashboardDb(config.paths.dbPath, (db) =>
      streamVideo(request, db, config.paths.runsRoot, jobId),
    )
  } catch (error) {
    console.error('dashboard: video request failed', error)
    return new Response(errorMessage(error), { status: 503 })
  }
}
