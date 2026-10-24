import type { SupabaseClient } from '@supabase/supabase-js'
import { loadAiConfig } from '../config'
import type { AiConfig } from '../types'
import { claimJobRun, finishJobRun } from './memory'
import { isLearningStopError, resolveLearningOpenAi, type LearningOpenAi } from './openai-judge'
import { loadRecentPairs } from './pairs'
import { runSelfReview } from './self-review'
import { EVAL_MIN_CASES, EVAL_TARGET_CASES, growEvalSet, loadEvalCases } from './eval-set'
import { countMemoryUpdates, trimSummary, writeDailyReport, type DailyReportSummary } from './report'
import { limaDateKey, limaHour } from './time'
import { compareCommonCases, examBaseModel, previousFinalRun, runExam, saveExamRun, type ExamVariant } from './exam'
import { LEARNED_RULES_MAX } from '../defaults'
import { loadLearnedRules } from './rules'
import { collectAdvisorProposals, collectRuleProposals } from './proposals'
import { applyProposal, enforceCap, isApplicable, rollbackLearnedRun, type Proposal } from './apply'
import { jaccard } from './similarity'

// ============================================================
// Nightly learning run, 03:00 Lima, once per line and day. Started from
// the flows cron (every minute) via `runNightlyLearningIfDue`; the
// ai_job_runs row (job 'daily_report', key account:date) is the lock,
// so two server instances never run the same night twice.
//
// Steps: grow the exam set from hard chats → self-review of the bot's
// replies → learning from advisors + rules → blind exam (live vs
// candidate) → automatic rollback if the live bot got worse than last
// night, else apply what passed → daily report. Fully automatic; nobody
// has to approve it.
// ============================================================

export const NIGHT_START_HOUR_LIMA = 3
const DAY_MS = 24 * 60 * 60_000
const BOOTSTRAP_LOOKBACK_MS = 30 * DAY_MS

export interface NightContext {
  db: SupabaseClient
  accountId: string
  config: AiConfig
  openai: LearningOpenAi
  now: Date
  dateKey: string
  since: Date
  summary: DailyReportSummary
}

function learningDisabled(): boolean {
  return process.env.AI_LEARNING_DISABLED === '1'
}

interface NightState {
  running: Promise<void> | null
  lastDateKey: string | null
}
const g = globalThis as { __wacrmNightlyLearning?: NightState }
function state(): NightState {
  g.__wacrmNightlyLearning ??= { running: null, lastDateKey: null }
  return g.__wacrmNightlyLearning
}

/** Pure: is it time to try tonight's run? */
export function isNightDue(now: Date, lastDateKey: string | null): boolean {
  return limaHour(now) >= NIGHT_START_HOUR_LIMA && limaDateKey(now) !== lastDateKey
}

/** Cron entry point. Cheap when not due; never throws. */
export async function runNightlyLearningIfDue(admin: SupabaseClient, now: Date = new Date()): Promise<void> {
  if (learningDisabled()) return
  const s = state()
  if (s.running || !isNightDue(now, s.lastDateKey)) return
  s.lastDateKey = limaDateKey(now)
  s.running = runNightForAllAccounts(admin, now)
    .catch((err: unknown) => {
      console.error('[ai-learning] nightly run failed:', err instanceof Error ? err.message : err)
    })
    .finally(() => {
      s.running = null
    })
  await s.running
}

async function runNightForAllAccounts(admin: SupabaseClient, now: Date): Promise<void> {
  const { data, error } = await admin.from('ai_configs').select('account_id').eq('is_active', true)
  if (error) throw new Error(`ai_configs: ${error.message}`)
  for (const row of data ?? []) {
    await runNightForAccount(admin, row.account_id as string, now)
  }
}

export async function runNightForAccount(
  db: SupabaseClient,
  accountId: string,
  now: Date,
): Promise<'done' | 'skipped' | 'failed'> {
  let config: AiConfig | null = null
  try {
    config = await loadAiConfig(db, accountId)
  } catch {
    config = null
  }
  const openai = config ? resolveLearningOpenAi(config) : null
  if (!config || !openai) return 'skipped'

  const dateKey = limaDateKey(now)
  const runId = await claimJobRun(db, accountId, 'daily_report', `${accountId}:${dateKey}`)
  if (!runId) return 'skipped' // already ran tonight (or migration 079 missing)

  const ctx: NightContext = {
    db,
    accountId,
    config,
    openai,
    now,
    dateKey,
    since: new Date(now.getTime() - DAY_MS),
    summary: { model: openai.model, errors: [] },
  }
  let status: 'done' | 'skipped' | 'failed' = 'done'
  let errorText: string | undefined
  let discarded = 0
  try {
    discarded += await stepEvalSet(ctx)
    discarded += await stepSelfReview(ctx, runId)
    discarded += await stepLearnAndExam(ctx, runId)
  } catch (err) {
    errorText = err instanceof Error ? err.message : String(err)
    status = isLearningStopError(err) ? 'skipped' : 'failed'
    ctx.summary.errors?.push(errorText)
    console.error('[ai-learning] night stopped:', errorText)
  }

  await writeDailyReport(db, accountId, dateKey, {
    learned_count: ctx.summary.learned?.length ?? 0,
    discarded_count: discarded,
    memory_count: await countMemoryUpdates(db, accountId, ctx.since),
    eval_before: ctx.summary.exam?.base ?? null,
    eval_after: ctx.summary.exam?.after ?? null,
    rolled_back: ctx.summary.rollback?.done ?? false,
    summary: trimSummary(ctx.summary),
  })
  await finishJobRun(db, runId, status, { ...ctx.summary, errors: undefined }, errorText)
  return status
}

/** Grow the fixed exam set from hard chats until it reaches its target. */
async function stepEvalSet(ctx: NightContext): Promise<number> {
  const existing = await loadEvalCases(ctx.db, ctx.accountId)
  let added = 0
  if (existing.length < EVAL_TARGET_CASES) {
    // Bootstrapping (fewer than the minimum): look back 30 days.
    const since =
      existing.length < EVAL_MIN_CASES ? new Date(ctx.now.getTime() - BOOTSTRAP_LOOKBACK_MS) : ctx.since
    const pairs = await loadRecentPairs(ctx.db, ctx.accountId, since)
    added = await growEvalSet(ctx.db, ctx.accountId, ctx.openai, pairs)
  }
  ctx.summary.eval_cases = { added, total: existing.length + added }
  return 0
}

/** Re-read the bot's replies of the day and store rule proposals. */
async function stepSelfReview(ctx: NightContext, parentRunId: string): Promise<number> {
  const runId =
    (await claimJobRun(ctx.db, ctx.accountId, 'self_review', `${ctx.accountId}:${ctx.dateKey}`)) ?? parentRunId
  const pairs = await loadRecentPairs(ctx.db, ctx.accountId, ctx.since)
  const result = await runSelfReview(ctx.db, ctx.accountId, ctx.openai, pairs, runId)
  ctx.summary.self_review = result
  if (runId !== parentRunId) await finishJobRun(ctx.db, runId, 'done', { ...result })
  if (result.rejected > 0) {
    ctx.summary.discarded = [
      ...(ctx.summary.discarded ?? []),
      { text: `${result.rejected} propuesta(s) de autorrevisión`, reason: 'Contenían precios o datos personales' },
    ]
  }
  return result.rejected
}

/** Exam drop (points, 0-100) that counts as "worse than yesterday".
 *  A small margin keeps the judge's own noise from rolling back good
 *  learning every night. */
export const ROLLBACK_TOLERANCE = 3
const LEARNING_LOOKBACK_MS = 7 * DAY_MS
const MAX_APPLY_EXAMPLES = 20
const MAX_APPLY_RULES = 5

export interface NightDecision {
  rollback: boolean
  apply: boolean
  note?: string
}

/** Pure: what tonight's exam numbers mean. */
export function decideNight(args: {
  base: number | null
  candidate: number | null
  reliable: boolean
  ready: number
  /** Tonight vs the previous night on their common cases (see
   *  compareCommonCases), or null on the first night. */
  regression: { today: number | null; previous: number | null; common: number } | null
}): NightDecision {
  const { base, candidate, reliable, ready, regression } = args
  // Rollback only on a trustworthy exam, comparing the same cases.
  if (
    reliable &&
    regression &&
    regression.common >= EVAL_MIN_CASES &&
    regression.today !== null &&
    regression.previous !== null &&
    regression.today < regression.previous - ROLLBACK_TOLERANCE
  ) {
    return { rollback: true, apply: false, note: 'La nota bajó frente a la noche anterior: se retrocedió lo aprendido en esa corrida' }
  }
  if (ready === 0) return { rollback: false, apply: false }
  if (!reliable) {
    return { rollback: false, apply: false, note: `Examen con menos de ${EVAL_MIN_CASES} casos: no se aprueba nada` }
  }
  if (base === null || candidate === null) return { rollback: false, apply: false, note: 'No se pudo tomar el examen' }
  if (candidate < base) return { rollback: false, apply: false, note: 'Lo aprendido bajaba la nota del examen: se descartó' }
  return { rollback: false, apply: true }
}

/**
 * Pure: the rules the bot will have if tonight's rules are applied —
 * newest first, as loadLearnedRules returns them, and cut at the cap
 * exactly like enforceCap (oldest active rules drop out). The exam
 * tests this list, so what is examined is what gets applied.
 */
export function projectRules(activeNewestFirst: string[], newInApplyOrder: string[], max: number = LEARNED_RULES_MAX): string[] {
  return [...[...newInApplyOrder].reverse(), ...activeNewestFirst].slice(0, max)
}

/** Pure: top-2 candidate examples per exam case, by word overlap. */
export function matchExamples(question: string, examples: Proposal[]): string[] {
  return examples
    .map((e) => ({ e, s: jaccard(question, e.question ?? e.content) }))
    .filter((x) => x.s >= 0.15)
    .sort((a, b) => b.s - a.s)
    .slice(0, 2)
    .map((x) => x.e.content)
}

/**
 * Phase 4: judge tonight's proposals, run the blind exam (live bot vs
 * live bot + ready proposals), roll back if the live bot got worse than
 * last night, apply what passed. Everything automatic.
 */
async function stepLearnAndExam(ctx: NightContext, runId: string): Promise<number> {
  const { db, accountId, config, openai } = ctx
  const pctx = { db, accountId, config, openai, runId }
  const learnSince = new Date(ctx.now.getTime() - LEARNING_LOOKBACK_MS)
  const activeRules = await loadLearnedRules(db, accountId, { fresh: true })

  const advisorRun = (await claimJobRun(db, accountId, 'advisor_learning', `${accountId}:${ctx.dateKey}`)) ?? runId
  const pairs = await loadRecentPairs(db, accountId, learnSince)
  const examples = await collectAdvisorProposals({ ...pctx, runId: advisorRun }, pairs)
  const rules = await collectRuleProposals(pctx, activeRules, learnSince)
  if (advisorRun !== runId) await finishJobRun(db, advisorRun, 'done', { ...examples.stats, discarded: undefined })

  ctx.summary.advisor_learning = {
    pairs: examples.stats.pairs,
    candidates: examples.stats.candidates,
    rejected: examples.stats.rejected,
    groups: examples.stats.groups,
  }
  ctx.summary.discarded = [...(ctx.summary.discarded ?? []), ...examples.stats.discarded, ...rules.stats.discarded]
  let discarded = examples.stats.rejected + rules.stats.rejected

  // Only what passes the final guard is examined, so the exam tests
  // exactly what can be applied.
  const readyExamples = examples.proposals
    .filter((p) => p.ready && isApplicable(p))
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_APPLY_EXAMPLES)
  const readyRules = rules.proposals
    .filter((p) => p.ready && isApplicable(p))
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_APPLY_RULES)
  const ready = [...readyExamples, ...readyRules]

  const cases = await loadEvalCases(db, accountId)
  if (cases.length === 0) {
    ctx.summary.exam = { base: null, candidate: null, after: null, cases: 0, approved: false, note: 'Todavía no hay examen: no se aprueba nada' }
    return discarded
  }

  const deps = { db, accountId, config, openai }
  const model = examBaseModel(config, openai)
  const base: ExamVariant = { label: 'base', model, rules: activeRules }
  const variants: ExamVariant[] = [base]
  if (ready.length > 0 && cases.length >= EVAL_MIN_CASES) {
    variants.push({
      label: 'candidato',
      model,
      rules: projectRules(activeRules, readyRules.map((r) => r.content)),
      extraKnowledge: (c) => matchExamples(c.question, readyExamples),
    })
  }
  const exam = await runExam(deps, cases, variants)
  const baseScore = exam.total > 0 ? exam.scores[0] : null
  const candScore = variants.length > 1 && exam.total > 0 ? exam.scores[1] : null
  const previousRun = await previousFinalRun(db, accountId, ctx.now)
  const regression = previousRun ? compareCommonCases(exam.details, 0, previousRun.cases) : null
  const decision = decideNight({ base: baseScore, candidate: candScore, reliable: exam.reliable, ready: ready.length, regression })

  let after = baseScore
  let afterRun: { result: typeof exam; variant: number } = { result: exam, variant: 0 }
  const learned: string[] = []
  if (decision.rollback) {
    // What the previous run applied, plus hand approvals made after it.
    const n = previousRun
      ? await rollbackLearnedRun(db, accountId, previousRun.jobRunId ?? '', new Date(previousRun.createdAt))
      : 0
    // Fresh score of the rolled-back bot, so tomorrow compares to it.
    const again = n > 0 ? await runExam(deps, cases, [{ ...base, rules: await loadLearnedRules(db, accountId, { fresh: true }) }]) : null
    after = again && again.total > 0 ? again.scores[0] : baseScore
    if (again && again.total > 0) afterRun = { result: again, variant: 0 }
    ctx.summary.rollback = { done: n > 0, items: n, previous: regression?.previous ?? null, current: regression?.today ?? null }
  } else if (decision.apply) {
    for (const p of ready) {
      const docId = await applyProposal(db, accountId, config, p, runId)
      if (docId) learned.push(p.title)
    }
    if (readyRules.length) await enforceCap(db, accountId, 'self_review')
    if (readyExamples.length) await enforceCap(db, accountId, 'advisor_learning')
    after = candScore
    afterRun = { result: exam, variant: 1 }
  } else if (ready.length > 0 && candScore !== null && baseScore !== null && candScore < baseScore) {
    // The exam said no: discard tonight's ready items.
    await db
      .from('ai_learning_candidates')
      .update({ verdict: 'rejected', rejected_by: 'eval_regression', decided_at: new Date().toISOString() })
      .in('id', ready.map((p) => p.candidateId))
    discarded += ready.length
    ctx.summary.discarded.push(...ready.map((p) => ({ text: p.title, reason: 'Bajaba la nota del examen' })))
  }
  ctx.summary.learned = learned
  ctx.summary.exam = {
    base: baseScore,
    candidate: candScore,
    after,
    cases: exam.total,
    approved: decision.apply && learned.length > 0,
    note: decision.note,
  }

  if (baseScore !== null) {
    await saveExamRun(db, accountId, runId, 'baseline', baseScore, exam, exam.passed[0], 0)
    if (candScore !== null) await saveExamRun(db, accountId, runId, 'before', baseScore, exam, exam.passed[0], 0)
  }
  if (after !== null) {
    const { result: ar, variant: v } = afterRun
    await saveExamRun(db, accountId, runId, 'after', after, ar, ar.passed[v] ?? 0, v)
  }
  return discarded
}
