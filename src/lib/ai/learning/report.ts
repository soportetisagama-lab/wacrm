import type { SupabaseClient } from '@supabase/supabase-js'

// ============================================================
// Daily learning report (ai_daily_reports), one per line and Lima day:
// what was learned, what was discarded and why, exam score before and
// after, and whether anything was rolled back. Admin-only (RLS); shown
// in Agentes IA > Aprendizaje. Never contains prices or personal data:
// every text in it already passed the guards.
// ============================================================

export interface DailyReportSummary {
  self_review?: { reviewed: number; proposed: number; rejected: number }
  eval_cases?: { added: number; total: number }
  advisor_learning?: { pairs: number; candidates: number; rejected: number; groups: number }
  /** Short titles of what became active tonight. */
  learned?: string[]
  /** Short reasons for what was discarded tonight (guard / judge / exam). */
  discarded?: { text: string; reason: string }[]
  /** Exam comparison tonight: base vs candidate. */
  exam?: {
    base: number | null
    candidate: number | null
    /** Score of the bot as it stays after tonight. */
    after: number | null
    cases: number
    approved: boolean
    note?: string
  }
  rollback?: { done: boolean; items: number; previous: number | null; current: number | null }
  model?: string
  errors?: string[]
}

export interface DailyReportRow {
  learned_count: number
  discarded_count: number
  memory_count: number
  eval_before: number | null
  eval_after: number | null
  rolled_back: boolean
  summary: DailyReportSummary
}

/** Memories refreshed since `since` (for the report). 0 on any error. */
export async function countMemoryUpdates(db: SupabaseClient, accountId: string, since: Date): Promise<number> {
  try {
    const { count } = await db
      .from('contact_ai_memory')
      .select('id', { count: 'exact', head: true })
      .eq('account_id', accountId)
      .gte('updated_at', since.toISOString())
    return count ?? 0
  } catch {
    return 0
  }
}

export async function writeDailyReport(
  db: SupabaseClient,
  accountId: string,
  dateKey: string,
  row: DailyReportRow,
): Promise<void> {
  const { error } = await db
    .from('ai_daily_reports')
    .upsert({ account_id: accountId, report_date: dateKey, ...row }, { onConflict: 'account_id,report_date' })
  if (error) console.error('[ai-learning] daily report write failed:', error.message)
}

/** Cap list sizes so a report row stays small. */
export function trimSummary(s: DailyReportSummary): DailyReportSummary {
  return {
    ...s,
    learned: s.learned?.slice(0, 30),
    discarded: s.discarded?.slice(0, 40).map((d) => ({ text: d.text.slice(0, 160), reason: d.reason.slice(0, 120) })),
    errors: s.errors?.slice(0, 10).map((e) => e.slice(0, 200)),
  }
}
