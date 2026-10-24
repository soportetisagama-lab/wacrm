import { AiError, type AiConfig, type AiUsage } from '../types'
import { normalizeUsage, providerHttpError, toNetworkError } from '../providers/shared'
import { assertAiKeyAvailable, noteAiKeyFailure, resumeAiKey } from '../availability'

// ============================================================
// OpenAI-only client for the learning jobs (memory, judge, self-review,
// eval). Background work, never customer-facing: Chat Completions with
// a strict JSON-schema response, so the output is always parseable.
// The learning layer uses OpenAI exclusively — on an Anthropic account
// it falls back to the OpenAI embeddings key, or stays off.
// ============================================================

const OPENAI_URL = 'https://api.openai.com/v1/chat/completions'
export const DEFAULT_JUDGE_MODEL = 'gpt-5.4-mini'
const DEFAULT_TIMEOUT_MS = 45_000
const DEFAULT_MAX_TOKENS = 1_500

export interface LearningOpenAi {
  apiKey: string
  model: string
}

/** OpenAI key + model for the learning jobs, or null when the account
 *  has no OpenAI key at all. Model: AI_JUDGE_MODEL, default gpt-5.4-mini. */
export function resolveLearningOpenAi(
  config: Pick<AiConfig, 'provider' | 'apiKey' | 'embeddingsApiKey'>,
): LearningOpenAi | null {
  const apiKey = config.provider === 'openai' ? config.apiKey : config.embeddingsApiKey
  if (!apiKey) return null
  const model = process.env.AI_JUDGE_MODEL?.trim() || DEFAULT_JUDGE_MODEL
  return { apiKey, model }
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
}

export interface JudgeCallResult {
  data: unknown
  usage: AiUsage | null
}

interface OpenAiJsonResponse {
  choices?: { message?: { content?: string | null; refusal?: string | null } }[]
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }
}

/** Low reasoning on gpt-5* / o-series keeps these calls cheap and
 *  stops hidden reasoning from eating the whole output budget. */
function reasoningParams(model: string): { reasoning_effort?: 'low' } {
  return /^(gpt-5|o\d)/i.test(model) ? { reasoning_effort: 'low' } : {}
}

/** One structured call. Throws AiError on HTTP/network failure, refusal
 *  or unparseable output. */
export async function callOpenAiJson(args: JudgeCallArgs): Promise<JudgeCallResult> {
  const { apiKey, model, system, user, schemaName, schema } = args
  assertAiKeyAvailable(apiKey)

  let res: Response
  try {
    res = await fetch(OPENAI_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        max_completion_tokens: args.maxTokens ?? DEFAULT_MAX_TOKENS,
        ...reasoningParams(model),
        response_format: {
          type: 'json_schema',
          json_schema: { name: schemaName, schema, strict: true },
        },
      }),
      signal: AbortSignal.timeout(args.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    })
  } catch (err) {
    throw toNetworkError(err)
  }

  if (!res.ok) {
    const err = await providerHttpError('OpenAI', res)
    noteAiKeyFailure(apiKey, err)
    throw err
  }
  resumeAiKey(apiKey)

  const body = (await res.json().catch(() => null)) as OpenAiJsonResponse | null
  const msg = body?.choices?.[0]?.message
  const usage = normalizeUsage({
    prompt: body?.usage?.prompt_tokens,
    completion: body?.usage?.completion_tokens,
    total: body?.usage?.total_tokens,
  })
  if (msg?.refusal) {
    throw new AiError('OpenAI refused the request.', { code: 'empty_response' })
  }
  const content = msg?.content
  if (!content || typeof content !== 'string') {
    throw new AiError('OpenAI returned an empty response.', { code: 'empty_response' })
  }
  try {
    return { data: JSON.parse(content), usage }
  } catch {
    throw new AiError('OpenAI returned malformed JSON.', { code: 'invalid_extraction' })
  }
}
