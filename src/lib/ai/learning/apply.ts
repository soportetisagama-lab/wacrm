import type { SupabaseClient } from '@supabase/supabase-js'
import { LEARNED_RULES_MAX } from '../defaults'
import { ingestDocument } from '../knowledge'
import type { AiConfig } from '../types'
import { checkLearnable, hasBareFigure } from './guards'
import { invalidateLearnedRules } from './rules'

// ============================================================
// Turning an approved proposal into something the bot uses, and the
// way back (delete / automatic rollback).
//   - example (from advisors) → ai_knowledge_documents source
//     'advisor_learning' + chunks, so the normal knowledge retrieval
//     finds it;
//   - rule (from self-review) → ai_knowledge_documents source
//     'self_review', no chunks, injected as a learned rule.
// Deactivating sets the document status and chunks.active=false, so
// the retrieval RPCs (migration 079) stop returning it at once.
// ============================================================

export type ProposalKind = 'example' | 'rule'

export interface Proposal {
  kind: ProposalKind
  candidateId: string
  title: string
  /** Document content: the rule, or "Cliente: … / Respuesta: …". */
  content: string
  /** The (generalized) customer question, for examples. */
  question: string | null
  score: number
  support: number
  ready: boolean
}

/** Max active learned examples per line (oldest are archived). */
export const LEARNED_EXAMPLES_MAX = 300

/** Pure: final safety check before anything becomes active. */
export function isApplicable(p: Pick<Proposal, 'content' | 'title'>): boolean {
  const text = `${p.title} ${p.content}`
  return checkLearnable(text).ok && !hasBareFigure(text)
}

export function exampleContent(question: string, answer: string): string {
  return `Cuando un cliente pregunta algo como: "${question}"\nUn asesor respondió bien así: "${answer}"`
}

/**
 * Activate one proposal. Returns the new document id, or null when it
 * failed the final guard, another caller already took it, or the insert
 * failed (nothing half-applied: a document whose chunks failed to index
 * is archived again and the proposal goes back to pending).
 *
 * Idempotent: the candidate is first claimed with a conditional update
 * (pending → accepted). Only the caller that wins the claim creates a
 * document, so a double click on "Aprobar ya" — or the night running
 * at the same time — can never create two.
 */
export async function applyProposal(
  db: SupabaseClient,
  accountId: string,
  config: Pick<AiConfig, 'embeddingsApiKey'>,
  p: Proposal,
  runId: string | null,
): Promise<string | null> {
  if (!isApplicable(p)) return null
  const { data: claimed } = await db
    .from('ai_learning_candidates')
    .update({ verdict: 'accepted', decided_at: new Date().toISOString(), rejected_by: null })
    .eq('id', p.candidateId)
    .eq('account_id', accountId)
    .eq('verdict', 'pending')
    .select('id')
  if (!claimed?.length) return null

  const release = async () => {
    await db
      .from('ai_learning_candidates')
      .update({ verdict: 'pending', decided_at: null })
      .eq('id', p.candidateId)
      .eq('account_id', accountId)
  }

  const { data: doc, error } = await db
    .from('ai_knowledge_documents')
    .insert({
      account_id: accountId,
      title: p.title.slice(0, 120),
      content: p.content,
      source: p.kind === 'rule' ? 'self_review' : 'advisor_learning',
      status: 'active',
      learning_run_id: runId,
    })
    .select('id')
    .maybeSingle()
  if (error || !doc) {
    console.error('[ai-learning] apply insert failed:', error?.message)
    await release()
    return null
  }
  const docId = doc.id as string
  if (p.kind === 'example') {
    try {
      await ingestDocument(db, accountId, config, docId, p.content)
    } catch (err) {
      // Lexical chunks are stored even when embedding fails; only a DB
      // failure lands here. Don't leave a half-indexed example active.
      const { count } = await db
        .from('ai_knowledge_chunks')
        .select('id', { count: 'exact', head: true })
        .eq('document_id', docId)
      if (!count) {
        await setDocumentStatus(db, accountId, docId, 'archived')
        await release()
        console.error('[ai-learning] example indexing failed:', err instanceof Error ? err.message : err)
        return null
      }
    }
  }
  await db
    .from('ai_learning_candidates')
    .update({ knowledge_document_id: docId })
    .eq('id', p.candidateId)
    .eq('account_id', accountId)
  if (p.kind === 'rule') invalidateLearnedRules(accountId)
  return docId
}

/** Set a learned document's status and (de)activate its chunks. */
export async function setDocumentStatus(
  db: SupabaseClient,
  accountId: string,
  docId: string,
  status: 'active' | 'archived' | 'rolled_back',
): Promise<boolean> {
  const { data, error } = await db
    .from('ai_knowledge_documents')
    .update({ status })
    .eq('id', docId)
    .eq('account_id', accountId)
    .neq('source', 'manual')
    .select('id')
  if (error || !data?.length) return false
  await db
    .from('ai_knowledge_chunks')
    .update({ active: status === 'active' })
    .eq('document_id', docId)
    .eq('account_id', accountId)
  invalidateLearnedRules(accountId)
  return true
}

/**
 * Automatic rollback of one night: deactivate what that run applied
 * (documents with its `learning_run_id`) plus what an admin approved by
 * hand ("Aprobar ya", no run id) after that run started. Documents →
 * 'rolled_back', chunks off, candidates → 'rolled_back'. Returns how
 * many documents were rolled back.
 */
export async function rollbackLearnedRun(
  db: SupabaseClient,
  accountId: string,
  runId: string | null,
  manualSince: Date | null,
): Promise<number> {
  const base = () =>
    db
      .from('ai_knowledge_documents')
      .select('id')
      .eq('account_id', accountId)
      .neq('source', 'manual')
      .eq('status', 'active')
  let fromRun: { id: unknown }[] = []
  if (runId) {
    const { data, error } = await base().eq('learning_run_id', runId)
    if (error) return 0
    fromRun = data ?? []
  }
  let manual: { id: unknown }[] = []
  if (manualSince) {
    const { data } = await base().is('learning_run_id', null).gte('created_at', manualSince.toISOString())
    manual = data ?? []
  }
  const docs = [...fromRun, ...manual]
  if (docs.length === 0) return 0
  let n = 0
  for (const d of docs) {
    if (await setDocumentStatus(db, accountId, d.id as string, 'rolled_back')) n += 1
  }
  await db
    .from('ai_learning_candidates')
    .update({ verdict: 'rolled_back', rejected_by: 'eval_regression', decided_at: new Date().toISOString() })
    .eq('account_id', accountId)
    .in(
      'knowledge_document_id',
      docs.map((d) => d.id as string),
    )
  return n
}

/** Keep at most `max` active documents of a source: archive the oldest. */
export async function enforceCap(
  db: SupabaseClient,
  accountId: string,
  source: 'self_review' | 'advisor_learning',
  max: number = source === 'self_review' ? LEARNED_RULES_MAX : LEARNED_EXAMPLES_MAX,
): Promise<number> {
  const { data } = await db
    .from('ai_knowledge_documents')
    .select('id')
    .eq('account_id', accountId)
    .eq('source', source)
    .eq('status', 'active')
    .order('created_at', { ascending: false })
  const extra = (data ?? []).slice(max)
  for (const d of extra) await setDocumentStatus(db, accountId, d.id as string, 'archived')
  return extra.length
}
