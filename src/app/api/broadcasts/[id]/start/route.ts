import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { startBroadcastSend } from '@/lib/broadcasts/server-worker'

/**
 * POST /api/broadcasts/[id]/start — starts (or resumes) sending the
 * 'pending' recipients of a broadcast on the server. Answers right
 * away; the send keeps running even if the tab is closed.
 *
 * Body (optional): { headerMediaUrl?: string } from the resume dialog.
 *
 * 202 { started: true, pending }    — launched in the background
 * 200 { started: false, pending: 0 } — nothing left to send
 * 409 { code: 'already_running' }   — already sending (this or another process)
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    // Same gate as /api/whatsapp/broadcast: Difusiones is admin-only and
    // a blast from the account's number is not recoverable.
    const { accountId, userId } = await requireRole('admin')

    const limit = checkRateLimit(`broadcast-start:${userId}`, RATE_LIMITS.broadcast)
    if (!limit.success) return rateLimitResponse(limit)

    const { id } = await params
    const body = (await request.json().catch(() => null)) as { headerMediaUrl?: unknown } | null
    const headerMediaUrl =
      typeof body?.headerMediaUrl === 'string' ? body.headerMediaUrl : undefined

    // Scoped to the caller's account inside startBroadcastSend.
    const res = await startBroadcastSend(id, accountId, { headerMediaUrl })
    switch (res.kind) {
      case 'started':
        return NextResponse.json({ started: true, pending: res.pending }, { status: 202 })
      case 'nothing_pending':
        return NextResponse.json({ started: false, pending: 0 })
      case 'already_running':
        return NextResponse.json(
          { error: 'La difusión ya se está enviando.', code: 'already_running' },
          { status: 409 },
        )
      case 'error':
        return NextResponse.json({ error: res.message }, { status: res.status })
    }
  } catch (error) {
    console.error('Error in broadcast start POST:', error)
    return toErrorResponse(error)
  }
}
