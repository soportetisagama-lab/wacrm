import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { supabaseAdmin } from '@/lib/ai/admin-client'

type Params = { params: Promise<{ id: string }> }

/**
 * DELETE /api/ai/learning/candidates/[id]  (admin+) — "Borrar" a
 * pending proposal: it is discarded and never applied.
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
    const { data, error } = await supabaseAdmin()
      .from('ai_learning_candidates')
      .update({
        verdict: 'rejected',
        rejected_by: null,
        reason: 'Descartado por un administrador',
        decided_at: new Date().toISOString(),
      })
      .eq('id', id)
      .eq('account_id', accountId)
      .eq('verdict', 'pending')
      .select('id')
    if (error) {
      console.error('[ai/learning/candidates DELETE] error:', error.message)
      return NextResponse.json({ error: 'Failed to discard' }, { status: 500 })
    }
    if (!data?.length) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    return NextResponse.json({ ok: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}
