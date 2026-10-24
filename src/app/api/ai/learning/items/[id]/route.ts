import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { supabaseAdmin } from '@/lib/ai/admin-client'
import { setDocumentStatus } from '@/lib/ai/learning/apply'

type Params = { params: Promise<{ id: string }> }

/**
 * DELETE /api/ai/learning/items/[id]  (admin+) — "Borrar" a learned
 * example or rule. It is archived (status + chunks off), so the bot
 * stops using it at once and the night never re-applies the same
 * candidate. Manual knowledge-base documents can't be touched here.
 */
export async function DELETE(_request: Request, { params }: Params) {
  try {
    const { accountId, userId } = await requireRole('admin')
    const limit = checkRateLimit(`ai-learning:${userId}`, RATE_LIMITS.adminAction)
    if (!limit.success) return rateLimitResponse(limit)

    const { id } = await params
    if (!/^[0-9a-f-]{36}$/i.test(id)) {
      return NextResponse.json({ error: 'Invalid id' }, { status: 400 })
    }
    const ok = await setDocumentStatus(supabaseAdmin(), accountId, id, 'archived')
    if (!ok) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    return NextResponse.json({ ok: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}
