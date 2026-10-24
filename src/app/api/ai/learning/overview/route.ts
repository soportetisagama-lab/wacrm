import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { checkLearnable, hasAmount, hasBareFigure, hasPersonalData } from '@/lib/ai/learning/guards'
import { supportOf } from '@/lib/ai/learning/proposals'

/** Text that passed the guards again, or a neutral placeholder. */
function safe(text: unknown): string {
  const t = typeof text === 'string' ? text.trim() : ''
  if (!t) return ''
  return checkLearnable(t).ok && !hasBareFigure(t) ? t : '(oculto por el filtro)'
}

/** Lighter check for report notes / reasons, which may name the rule
 *  ("contenía precios") but never carry a figure or personal data. */
function safeLabel(text: unknown): string {
  const t = typeof text === 'string' ? text.trim() : ''
  if (!t) return ''
  return hasAmount(t) || hasPersonalData(t) ? '(oculto por el filtro)' : t
}

function missingTable(code: string | undefined): boolean {
  return code === '42P01' || code === 'PGRST205' || code === '42703'
}

/**
 * GET /api/ai/learning/overview  (admin+)
 *
 * Everything the "Aprendizaje" tab shows besides the customer memory:
 * active learned knowledge and rules, pending proposals, the last exam
 * score and the daily reports. Admin-only, mirroring the RLS of the
 * learning tables (migration 079); advisors never see any of it.
 */
export async function GET() {
  try {
    const { supabase, accountId } = await requireRole('admin')

    const [learned, pending, exam, reports] = await Promise.all([
      supabase
        .from('ai_knowledge_documents')
        .select('id, source, title, content, created_at')
        .eq('account_id', accountId)
        .in('source', ['advisor_learning', 'self_review'])
        .eq('status', 'active')
        .order('created_at', { ascending: false })
        .limit(200),
      supabase
        .from('ai_learning_candidates')
        .select('id, source, customer_text, improved_text, score, reason, created_at')
        .eq('account_id', accountId)
        .eq('verdict', 'pending')
        .not('improved_text', 'is', null)
        .order('created_at', { ascending: false })
        .limit(50),
      supabase
        .from('ai_eval_runs')
        .select('score, cases_total, cases_passed, created_at')
        .eq('account_id', accountId)
        .eq('phase', 'after')
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle(),
      supabase
        .from('ai_daily_reports')
        .select('report_date, learned_count, discarded_count, memory_count, eval_before, eval_after, rolled_back, summary')
        .eq('account_id', accountId)
        .order('report_date', { ascending: false })
        .limit(14),
    ])

    const firstError = learned.error ?? pending.error ?? exam.error ?? reports.error
    if (firstError) {
      if (missingTable(firstError.code)) {
        return NextResponse.json({ ready: false, learned: [], pending: [], lastExam: null, reports: [] })
      }
      console.error('[ai/learning/overview GET] error:', firstError.message)
      return NextResponse.json({ error: 'Failed to load learning' }, { status: 500 })
    }

    return NextResponse.json({
      ready: true,
      learned: (learned.data ?? []).map((d) => ({
        id: d.id,
        kind: d.source === 'self_review' ? 'rule' : 'example',
        title: safe(d.title),
        content: safe(d.content),
        created_at: d.created_at,
      })),
      pending: (pending.data ?? []).map((c) => ({
        id: c.id,
        kind: c.source === 'self_review' ? 'rule' : 'example',
        question: c.source === 'self_review' ? '' : safe(c.customer_text),
        proposal: safe(c.improved_text),
        score: c.score === null ? null : Number(c.score),
        support: supportOf(c.reason),
        created_at: c.created_at,
      })),
      lastExam: exam.data
        ? {
            score: Number(exam.data.score),
            cases_total: exam.data.cases_total,
            cases_passed: exam.data.cases_passed,
            created_at: exam.data.created_at,
          }
        : null,
      reports: (reports.data ?? []).map((r) => {
        const s = (r.summary ?? {}) as {
          learned?: string[]
          discarded?: { text: string; reason: string }[]
          exam?: { note?: string; cases?: number }
        }
        return {
          report_date: r.report_date,
          learned_count: r.learned_count,
          discarded_count: r.discarded_count,
          memory_count: r.memory_count,
          eval_before: r.eval_before === null ? null : Number(r.eval_before),
          eval_after: r.eval_after === null ? null : Number(r.eval_after),
          rolled_back: r.rolled_back,
          learned: (s.learned ?? []).map(safe).slice(0, 10),
          discarded: (s.discarded ?? []).slice(0, 10).map((d) => ({ text: safe(d.text), reason: safeLabel(d.reason) })),
          note: s.exam?.note ? safeLabel(s.exam.note) : null,
        }
      }),
    })
  } catch (err) {
    return toErrorResponse(err)
  }
}
