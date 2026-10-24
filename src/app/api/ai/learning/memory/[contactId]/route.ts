import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { supabaseAdmin } from '@/lib/ai/admin-client'

type Params = { params: Promise<{ contactId: string }> }

/**
 * DELETE /api/ai/learning/memory/[contactId]  (admin+) — "Borrar memoria".
 *
 * Empties the memory and stamps `cleared_at`, so the sweep only learns
 * again from messages written after this moment (deleting the row would
 * let the next sweep rebuild the same memory from the old chat).
 * Written with the service role: contact_ai_memory has no write
 * policies for `authenticated` (migration 079); the admin check above
 * and the account_id filter scope it.
 */
export async function DELETE(_request: Request, { params }: Params) {
  try {
    const { accountId, userId } = await requireRole('admin')
    const limit = checkRateLimit(`ai-memory:${userId}`, RATE_LIMITS.adminAction)
    if (!limit.success) return rateLimitResponse(limit)

    const { contactId } = await params
    if (!/^[0-9a-f-]{36}$/i.test(contactId)) {
      return NextResponse.json({ error: 'Invalid contact' }, { status: 400 })
    }

    const now = new Date().toISOString()
    const { data, error } = await supabaseAdmin()
      .from('contact_ai_memory')
      .update({ memory: {}, cleared_at: now, last_message_at_seen: now, model: null })
      .eq('account_id', accountId)
      .eq('contact_id', contactId)
      .select('contact_id')

    if (error) {
      console.error('[ai/learning/memory DELETE] error:', error.message)
      return NextResponse.json({ error: 'Failed to clear memory' }, { status: 500 })
    }
    if (!data?.length) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    return NextResponse.json({ ok: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}
