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
import { examBaseModel, runExam, saveExamRun } from './exam'

// ============================================================
// Nightly learning run, 03:00 Lima, once per line and day. Started from
// the flows cron (every minute) via `runNightlyLearningIfDue`; the
// ai_job_runs row (job 'daily_report', key account:date) is the lock,
// so two server instances never run the same night twice.
//
// Steps: grow the exam set from hard chats → self-review of the bot's
// replies → exam of the live bot → daily report. Fully automatic; nobody has to approve it.
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
    await stepExam(ctx, runId)
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
    eval_after: ctx.summary.exam?.candidate ?? null,
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

/** Tonight's exam of the live bot (score kept for tomorrow's compare). */
async function stepExam(ctx: NightContext, runId: string): Promise<void> {
  const cases = await loadEvalCases(ctx.db, ctx.accountId)
  if (cases.length === 0) {
    ctx.summary.exam = { base: null, candidate: null, cases: 0, approved: false, note: 'Todavía no hay examen' }
    return
  }
  const deps = { db: ctx.db, accountId: ctx.accountId, config: ctx.config, openai: ctx.openai }
  const model = examBaseModel(ctx.config, ctx.openai)
  const result = await runExam(deps, cases, [{ label: 'base', model, rules: [] }])
  const score = result.total > 0 ? result.scores[0] : null
  ctx.summary.exam = {
    base: score,
    candidate: null,
    cases: result.total,
    approved: false,
    note: result.reliable ? undefined : `Examen con menos de ${EVAL_MIN_CASES} casos: no se aprueba nada`,
  }
  if (score === null) return
  await saveExamRun(ctx.db, ctx.accountId, runId, 'baseline', score, result, result.passed[0], 0)
  await saveExamRun(ctx.db, ctx.accountId, runId, 'after', score, result, result.passed[0], 0)
}
