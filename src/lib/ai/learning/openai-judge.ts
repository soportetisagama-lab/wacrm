import { AiError, type AiConfig, type AiUsage } from '../types'
import { normalizeUsage, providerHttpError, toNetworkError } from '../providers/shared'
import { isAiKeyPaused, isAiOutOfServiceError } from '../availability'

// ============================================================
// OpenAI-only client for the learning jobs (memory, judge, self-review,
// eval). Background work, never customer-facing: Chat Completions with
// a strict JSON-schema response, so the output is always parseable.
// The learning layer uses OpenAI exclusively — on an Anthropic account
// it falls back to the OpenAI embeddings key, or stays off.
//
// It NEVER touches the bot's key circuit breaker (availability.ts):
// a background failure must not pause the key the bot answers with.
// It only reads it (a key the bot already paused is skipped) and keeps
// its own, separate pause for the learning jobs.
// ============================================================

const OPENAI_URL = 'https://api.openai.com/v1/chat/completions'
export const DEFAULT_JUDGE_MODEL = 'gpt-5.4-mini'
const DEFAULT_TIMEOUT_MS = 45_000
const DEFAULT_MAX_TOKENS = 1_500
/** Learning-only pause after an out-of-service error (no credit, key
 *  rejected): background jobs skip that key for this long. */
export const LEARNING_PAUSE_MS = 60 * 60_000

export interface LearningOpenAi {
  apiKey: string
  model: string
  /** Model to retry with when `model` is not available to this key —
   *  the account's own chat model from ai_configs (OpenAI accounts). */
  fallbackModel?: string | null
}

/** OpenAI key + model for the learning jobs, or null when the account
 *  has no OpenAI key at all. Model: AI_JUDGE_MODEL, default gpt-5.4-mini;
 *  falls back to the configured chat model on an OpenAI account. */
export function resolveLearningOpenAi(
  config: Pick<AiConfig, 'provider' | 'apiKey' | 'embeddingsApiKey'> & { model?: string },
): LearningOpenAi | null {
  const apiKey = config.provider === 'openai' ? config.apiKey : config.embeddingsApiKey
  if (!apiKey) return null
  const model = process.env.AI_JUDGE_MODEL?.trim() || DEFAULT_JUDGE_MODEL
  const fallbackModel =
    config.provider === 'openai' && config.model && config.model !== model ? config.model : null
  return { apiKey, model, fallbackModel }
}

export interface JudgeCallArgs extends LearningOpenAi {
  system: string
  user: string
  /** Name for the JSON schema (letters, digits, _ and -). */
  schemaName: string
  /** Strict JSON schema (additionalProperties:false, all keys required). */
  schema: Record<string, unknown>
  maxTokens?: number
  timeoutMs?: number
  /** Called with the provider's usage whenever it is known — also when
   *  the answer is then rejected (refusal, bad JSON) — so callers can
   *  log spend even for a failed call. */
  onUsage?: (usage: AiUsage, model: string) => void
}

export interface JudgeCallResult {
  data: unknown
  usage: AiUsage | null
  /** The model that actually answered (may be the fallback). */
  model: string
}

interface OpenAiJsonResponse {
  choices?: { message?: { content?: string | null; refusal?: string | null } }[]
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }
}

// --- Learning-only state (per process) ------------------------

const learningPausedUntil = new Map<string, number>()
/** "key|model" pairs OpenAI said are not available to that key. */
const unavailableModels = new Set<string>()

export function isLearningKeyPaused(apiKey: string, now: number = Date.now()): boolean {
  const until = learningPausedUntil.get(apiKey)
  return until !== undefined && now < until
}

/** Test-only. */
export function resetLearningAvailability(): void {
  learningPausedUntil.clear()
  unavailableModels.clear()
}

/** True for errors after which the whole background run should stop
 *  (and be retried later), not just skip one item. */
export function isLearningStopError(err: unknown): boolean {
  return err instanceof AiError && (err.code === 'learning_paused' || err.code === 'no_credit' || err.code === 'invalid_key' || err.code === 'rate_limited')
}

/** Low reasoning on gpt-5* / o-series keeps these calls cheap and
 *  stops hidden reasoning from eating the whole output budget. */
function reasoningParams(model: string): { reasoning_effort?: 'low' } {
  return /^(gpt-5|o\d)/i.test(model) ? { reasoning_effort: 'low' } : {}
}

/** 400/403/404 that names the model: the key can't use this model. */
export function isModelUnavailable(status: number, message: string): boolean {
  return (status === 400 || status === 403 || status === 404) && /model/i.test(message)
}

class ModelUnavailableError extends AiError {}

interface RawCall {
  apiKey: string
  model: string
  messages: { role: 'system' | 'user' | 'assistant'; content: string }[]
  maxTokens: number
  timeoutMs: number
  responseFormat?: Record<string, unknown>
  onUsage?: (usage: AiUsage, model: string) => void
}

/** One HTTP call. Returns the message text + usage; never touches the
 *  bot's circuit breaker. */
async function rawCall(c: RawCall): Promise<{ content: string; usage: AiUsage | null }> {
  let res: Response
  try {
    res = await fetch(OPENAI_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${c.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: c.model,
        messages: c.messages,
        max_completion_tokens: c.maxTokens,
        ...reasoningParams(c.model),
        ...(c.responseFormat ? { response_format: c.responseFormat } : {}),
      }),
      signal: AbortSignal.timeout(c.timeoutMs),
    })
  } catch (err) {
    throw toNetworkError(err)
  }

  if (!res.ok) {
    const err = await providerHttpError('OpenAI', res)
    if (isModelUnavailable(res.status, err.message)) {
      throw new ModelUnavailableError(err.message, { code: 'model_unavailable', status: res.status })
    }
    throw err
  }

  const body = (await res.json().catch(() => null)) as OpenAiJsonResponse | null
  const msg = body?.choices?.[0]?.message
  const usage = normalizeUsage({
    prompt: body?.usage?.prompt_tokens,
    completion: body?.usage?.completion_tokens,
    total: body?.usage?.total_tokens,
  })
  if (usage && c.onUsage) c.onUsage(usage, c.model)
  if (msg?.refusal) {
    throw new AiError('OpenAI refused the request.', { code: 'empty_response' })
  }
  const content = msg?.content
  if (!content || typeof content !== 'string' || !content.trim()) {
    throw new AiError('OpenAI returned an empty response.', { code: 'empty_response' })
  }
  return { content, usage }
}

/**
 * Run `once` with the judge model, then once more with `fallbackModel`
 * when the first is not available to the key (remembered for the
 * process). Out-of-service errors pause only the learning jobs.
 */
async function withModelFallback<T>(target: LearningOpenAi, once: (model: string) => Promise<T>): Promise<T> {
  const { apiKey } = target
  if (isAiKeyPaused(apiKey) || isLearningKeyPaused(apiKey)) {
    throw new AiError('Learning skipped: the OpenAI key is paused.', { code: 'learning_paused' })
  }
  const models = [target.model, target.fallbackModel].filter(
    (m, i, all): m is string => Boolean(m) && all.indexOf(m) === i,
  )
  const usable = models.filter((m) => !unavailableModels.has(`${apiKey}|${m}`))
  if (usable.length === 0) {
    throw new AiError('Learning skipped: no OpenAI model available to this key.', { code: 'model_unavailable' })
  }

  let lastErr: unknown = null
  for (const model of usable) {
    try {
      return await once(model)
    } catch (err) {
      lastErr = err
      if (err instanceof ModelUnavailableError) {
        unavailableModels.add(`${apiKey}|${model}`)
        console.warn(`[ai-learning] model ${model} not available to this key — trying the configured model.`)
        continue
      }
      if (isAiOutOfServiceError(err)) {
        learningPausedUntil.set(apiKey, Date.now() + LEARNING_PAUSE_MS)
      }
      throw err
    }
  }
  throw lastErr
}

/**
 * One structured call. Retries once with `fallbackModel` when the judge
 * model isn't available to the key (and remembers that for the
 * process). Throws AiError on HTTP/network failure, refusal or
 * unparseable output — never pauses the bot's key.
 */
export async function callOpenAiJson(args: JudgeCallArgs): Promise<JudgeCallResult> {
  return withModelFallback(args, async (model) => {
    const { content, usage } = await rawCall({
      apiKey: args.apiKey,
      model,
      messages: [
        { role: 'system', content: args.system },
        { role: 'user', content: args.user },
      ],
      maxTokens: args.maxTokens ?? DEFAULT_MAX_TOKENS,
      timeoutMs: args.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      responseFormat: {
        type: 'json_schema',
        json_schema: { name: args.schemaName, schema: args.schema, strict: true },
      },
      onUsage: args.onUsage,
    })
    try {
      return { data: JSON.parse(content), usage, model }
    } catch {
      throw new AiError('OpenAI returned malformed JSON.', { code: 'invalid_extraction' })
    }
  })
}

export interface TextCallArgs extends LearningOpenAi {
  system: string
  messages: { role: 'user' | 'assistant'; content: string }[]
  maxTokens?: number
  timeoutMs?: number
  onUsage?: (usage: AiUsage, model: string) => void
}

/**
 * Plain-text completion for the exam runner (the bot's reply to an exam
 * question). Same safety as callOpenAiJson: no bot-key pause, model
 * fallback. `fallbackModel` is not used when the caller pins a model
 * on purpose (model comparison): pass it as null then.
 */
export async function callOpenAiText(args: TextCallArgs): Promise<{ text: string; usage: AiUsage | null; model: string }> {
  return withModelFallback(args, async (model) => {
    const { content, usage } = await rawCall({
      apiKey: args.apiKey,
      model,
      messages: [{ role: 'system', content: args.system }, ...args.messages],
      maxTokens: args.maxTokens ?? 800,
      timeoutMs: args.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      onUsage: args.onUsage,
    })
    return { text: content, usage, model }
  })
}
