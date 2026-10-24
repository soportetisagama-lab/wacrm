import type { SupabaseClient } from '@supabase/supabase-js'
import { logAiUsage } from '../usage'
import type { AiUsage } from '../types'

export type LearningMode = 'memory' | 'learning' | 'self_review' | 'eval'

/** `onUsage` callback for callOpenAiJson: logs every learning call to
 *  ai_usage_log under its own mode, also when the answer is rejected. */
export function usageLogger(
  db: SupabaseClient,
  accountId: string,
  mode: LearningMode,
  conversationId: string | null = null,
): (usage: AiUsage, model: string) => void {
  return (usage, model) =>
    void logAiUsage(db, { accountId, conversationId, mode, provider: 'openai', model, usage })
}
