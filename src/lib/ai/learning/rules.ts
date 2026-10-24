import type { SupabaseClient } from '@supabase/supabase-js'
import { LEARNED_RULES_MAX } from '../defaults'
import { checkLearnable, hasBareFigure } from './guards'

// ============================================================
// Learned rules: short general instructions the nightly self-review
// proposed and the judge + exam approved. Stored as
// ai_knowledge_documents (source='self_review', status='active', no
// chunks) and injected in the auto-reply / collect_ai prompt, always
// before the no-prices rule. At most LEARNED_RULES_MAX (20) active.
// ============================================================

const CACHE_MS = 2 * 60_000

interface CacheEntry {
  at: number
  rules: string[]
}
const g = globalThis as { __wacrmLearnedRules?: Map<string, CacheEntry> }
function cache(): Map<string, CacheEntry> {
  g.__wacrmLearnedRules ??= new Map()
  return g.__wacrmLearnedRules
}

/** Forget the cached rules of an account (after a change). */
export function invalidateLearnedRules(accountId: string): void {
  cache().delete(accountId)
}

/** Pure: rules that are still safe to show the model. */
export function safeRules(contents: unknown[]): string[] {
  return contents
    .filter((c): c is string => typeof c === 'string')
    .map((c) => c.replace(/\s+/g, ' ').trim())
    .filter((c) => c && checkLearnable(c).ok && !hasBareFigure(c))
    .slice(0, LEARNED_RULES_MAX)
}

/** Active learned rules for the prompt (cached 2 min). Never throws. */
export async function loadLearnedRules(
  db: SupabaseClient,
  accountId: string,
  opts: { fresh?: boolean } = {},
): Promise<string[]> {
  if (process.env.AI_LEARNING_DISABLED === '1') return []
  const hit = cache().get(accountId)
  if (!opts.fresh && hit && Date.now() - hit.at < CACHE_MS) return hit.rules
  try {
    const { data, error } = await db
      .from('ai_knowledge_documents')
      .select('content')
      .eq('account_id', accountId)
      .eq('source', 'self_review')
      .eq('status', 'active')
      // Newest first, same order enforceCap keeps (created_at).
      .order('created_at', { ascending: false })
      .limit(LEARNED_RULES_MAX)
    const rules = error ? [] : safeRules((data ?? []).map((d) => d.content))
    cache().set(accountId, { at: Date.now(), rules })
    return rules
  } catch {
    return []
  }
}
