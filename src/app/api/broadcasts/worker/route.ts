import { NextResponse } from 'next/server'
import { isAuthorizedCronSecret } from '@/lib/cron/internal'
import { resumeOrphanedBroadcasts } from '@/lib/broadcasts/server-worker'

/**
 * POST /api/broadcasts/worker — retakes broadcasts whose server worker
 * died (restart / deploy). Called at boot and every minute by the
 * in-process scheduler (instrumentation-node.ts) with the cron secret.
 */
export async function POST(request: Request) {
  if (!isAuthorizedCronSecret(request.headers.get('x-cron-secret') ?? '')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  try {
    const result = await resumeOrphanedBroadcasts()
    return NextResponse.json(result)
  } catch (err) {
    console.error('[broadcast-worker] sweep failed:', err)
    return NextResponse.json({ error: 'sweep failed' }, { status: 500 })
  }
}
