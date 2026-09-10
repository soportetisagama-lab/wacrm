import { AiError, type AiUsage, type ChatMessage, type ContentBlock } from '../types'

// ============================================================
// Bits shared by the OpenAI + Anthropic adapters.
// ============================================================

export interface ProviderArgs {
  apiKey: string
  model: string
  systemPrompt: string
  messages: ChatMessage[]
  timeoutMs: number
}

/**
 * Args for a forced-tool-call structured-output request (used by
 * `extractWithReply` in `../generate`). `schema` is a JSON Schema
 * object; `toolName` is the single tool both providers are forced to
 * call, so the response is always parseable as that schema.
 */
export interface StructuredProviderArgs extends ProviderArgs {
  schema: Record<string, unknown>
  toolName: string
}

/** Parsed tool-call arguments + usage, before any field-level validation. */
export interface StructuredProviderResult {
  data: unknown
  usage: AiUsage | null
}

/**
 * Coerce a provider's usage block into our normalized `AiUsage`, tolerant
 * of missing/partial fields (providers differ and older API versions may
 * omit counts). Returns null when there's nothing usable, so logging can
 * distinguish "no usage reported" from "zero tokens". `total` falls back
 * to prompt + completion when the provider doesn't send it (Anthropic).
 */
export function normalizeUsage(raw: {
  prompt?: unknown
  completion?: unknown
  total?: unknown
}): AiUsage | null {
  const num = (v: unknown): number =>
    typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0
  const promptTokens = num(raw.prompt)
  const completionTokens = num(raw.completion)
  const total = num(raw.total)
  const totalTokens = total > 0 ? total : promptTokens + completionTokens
  if (promptTokens === 0 && completionTokens === 0 && totalTokens === 0) {
    return null
  }
  return { promptTokens, completionTokens, totalTokens }
}

/** Map a fetch rejection (timeout / DNS / offline) to a typed AiError. */
export function toNetworkError(err: unknown): AiError {
  if (err instanceof DOMException && err.name === 'TimeoutError') {
    return new AiError('The AI provider took too long to respond.', {
      code: 'timeout',
      status: 504,
    })
  }
  const msg = err instanceof Error ? err.message : String(err)
  return new AiError(`Could not reach the AI provider: ${msg}`, {
    code: 'network_error',
    status: 502,
  })
}

/** Build a typed AiError from a non-2xx provider response, pulling the
 *  provider's own error message out of the JSON body when present. */
export async function providerHttpError(
  provider: string,
  res: Response,
): Promise<AiError> {
  let detail = ''
  try {
    const body = (await res.json()) as { error?: { message?: string } | string }
    detail =
      typeof body?.error === 'string'
        ? body.error
        : (body?.error?.message ?? '')
  } catch {
    // Non-JSON error body — fall back to the status line.
  }

  const { status } = res
  const code =
    status === 401 || status === 403
      ? 'invalid_key'
      : status === 429
        ? 'rate_limited'
        : 'provider_error'
  const base =
    code === 'invalid_key'
      ? `${provider} rejected the API key`
      : code === 'rate_limited'
        ? `${provider} rate limit reached`
        : `${provider} API error (${status})`

  return new AiError(detail ? `${base}: ${detail}` : base, {
    code,
    // Surface an auth failure as 401 so the settings "Test key" button
    // can show "invalid key"; everything else is an upstream 502.
    status: code === 'invalid_key' ? 401 : 502,
  })
}

function toBlocks(content: string | ContentBlock[]): ContentBlock[] {
  return typeof content === 'string' ? [{ type: 'text', text: content }] : content
}

/**
 * Merge two same-role turns' content. Both plain strings (the common
 * case) join with blank lines, same as always. If either side already
 * carries an image, string concatenation doesn't make sense — both
 * sides are normalized to blocks and concatenated instead (a plain-text
 * side becomes one text block); adjacent text blocks are left separate
 * rather than glued into one, which both providers render fine.
 */
function mergeContent(
  a: string | ContentBlock[],
  b: string | ContentBlock[],
): string | ContentBlock[] {
  if (typeof a === 'string' && typeof b === 'string') {
    return `${a}\n\n${b}`
  }
  return [...toBlocks(a), ...toBlocks(b)]
}

/**
 * Collapse consecutive same-role turns into one. Anthropic requires
 * strictly alternating roles; merging is also harmless for OpenAI and
 * keeps the transcript compact.
 */
export function mergeConsecutive(messages: ChatMessage[]): ChatMessage[] {
  const out: ChatMessage[] = []
  for (const m of messages) {
    const last = out[out.length - 1]
    if (last && last.role === m.role) {
      last.content = mergeContent(last.content, m.content)
    } else {
      out.push({ role: m.role, content: m.content })
    }
  }
  return out
}
