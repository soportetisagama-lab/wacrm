import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { supabaseAdmin } from '@/lib/ai/admin-client'
import { loadAiConfig } from '@/lib/ai/config'
import { applyProposal, enforceCap, exampleContent, isApplicable, type Proposal } from '@/lib/ai/learning/apply'

type Params = { params: Promise<{ id: string }> }

/**
 * POST /api/ai/learning/candidates/[id]/approve  (admin+) — optional
 * "Aprobar ya": activates a pending proposal now instead of waiting for
 * the night. The guards still run (applyProposal re-checks prices and
 * personal data), and the next night's exam can still roll it back.
 * Idempotent: a double click never creates two documents.
 */
export async function POST(_request: Request, { params }: Params) {
  try {
    const { accountId, userId } = await requireRole('admin')
    const limit = checkRateLimit(`ai-learning:${userId}`, RATE_LIMITS.adminAction)
    if (!limit.success) return rateLimitResponse(limit)

    const { id } = await params
    if (!/^[0-9a-f-]{36}$/i.test(id)) {
      return NextResponse.json({ error: 'Invalid id' }, { status: 400 })
    }
    const db = supabaseAdmin()
    const { data: c, error } = await db
      .from('ai_learning_candidates')
      .select('id, source, customer_text, improved_text, score')
      .eq('id', id)
      .eq('account_id', accountId)
      .eq('verdict', 'pending')
      .maybeSingle()
    if (error) {
      console.error('[ai/learning/approve] error:', error.message)
      return NextResponse.json({ error: 'Failed to load proposal' }, { status: 500 })
    }
    if (!c?.improved_text) {
      // Idempotent: a second click after it was applied is a success.
      const { data: done } = await db
        .from('ai_learning_candidates')
        .select('id')
        .eq('id', id)
        .eq('account_id', accountId)
        .eq('verdict', 'accepted')
        .maybeSingle()
      return done
        ? NextResponse.json({ ok: true, already: true })
        : NextResponse.json({ error: 'Not found' }, { status: 404 })
    }

    const isRule = c.source === 'self_review'
    const text = String(c.improved_text)
    const question = String(c.customer_text ?? '')
    const proposal: Proposal = {
      kind: isRule ? 'rule' : 'example',
      candidateId: c.id as string,
      title: isRule ? `Regla: ${text.slice(0, 100)}` : `Aprendido: ${question.slice(0, 100)}`,
      content: isRule ? text : exampleContent(question, text),
      question: isRule ? null : question,
      score: Number(c.score ?? 0),
      support: 0,
      ready: true,
    }
    if (!isApplicable(proposal)) {
      return NextResponse.json({ error: 'Blocked by the price / personal data filter' }, { status: 422 })
    }
    const config = await loadAiConfig(db, accountId, { requireActive: false }).catch(() => null)
    const docId = await applyProposal(db, accountId, { embeddingsApiKey: config?.embeddingsApiKey ?? null }, proposal, null)
    // applyProposal claims the candidate atomically (pending → accepted):
    // when a parallel click won the claim, this one creates nothing.
    if (!docId) {
      const { data: now } = await db
        .from('ai_learning_candidates')
        .select('verdict')
        .eq('id', id)
        .eq('account_id', accountId)
        .maybeSingle()
      return now?.verdict === 'accepted'
        ? NextResponse.json({ ok: true, already: true })
        : NextResponse.json({ error: 'Failed to apply' }, { status: 500 })
    }
    await enforceCap(db, accountId, isRule ? 'self_review' : 'advisor_learning')
    return NextResponse.json({ ok: true, id: docId })
  } catch (err) {
    return toErrorResponse(err)
  }
}
