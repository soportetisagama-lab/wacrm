import {
  AiError,
  type AiConfig,
  type AiUsage,
  type ChatMessage,
  type GenerateResult,
} from './types'
import { HANDOFF_SENTINEL, aiRequestTimeoutMs } from './defaults'
import {
  buildExtractionPrompt,
  buildExtractionSchema,
  EXTRACTION_TOOL_NAME,
  type ExtractionField,
} from './schema'
import { generateOpenAi, generateOpenAiStructured } from './providers/openai'
import { generateAnthropic, generateAnthropicStructured } from './providers/anthropic'

export interface GenerateArgs {
  config: AiConfig
  /** Fully-built system prompt (see `buildSystemPrompt`). */
  systemPrompt: string
  /** Recent conversation turns, oldest first. */
  messages: ChatMessage[]
}

/**
 * Generate the next reply from the account's configured provider.
 * Dispatches to the right adapter, then parses the handoff sentinel out
 * of the raw text. Throws `AiError` on any provider/network failure.
 */
export async function generateReply(args: GenerateArgs): Promise<GenerateResult> {
  const { config, systemPrompt, messages } = args
  const timeoutMs = aiRequestTimeoutMs()
  const providerArgs = {
    apiKey: config.apiKey,
    model: config.model,
    systemPrompt,
    messages,
    timeoutMs,
  }

  let result: { text: string; usage: AiUsage | null }
  switch (config.provider) {
    case 'openai':
      result = await generateOpenAi(providerArgs)
      break
    case 'anthropic':
      result = await generateAnthropic(providerArgs)
      break
    default:
      throw new AiError(`Unsupported AI provider: ${config.provider}`, {
        code: 'unsupported_provider',
        status: 400,
      })
  }

  return parseGeneration(result.text, result.usage)
}

/**
 * Split the raw model output into `{ text, handoff, usage }`. The
 * sentinel can appear alone or trailing a partial reply; either way we
 * treat the turn as a handoff and strip the marker from any remaining
 * text. `usage` is passed straight through (null when the provider
 * didn't report it).
 */
export function parseGeneration(
  raw: string,
  usage: AiUsage | null = null,
): GenerateResult {
  const handoff = raw.includes(HANDOFF_SENTINEL)
  const text = raw.split(HANDOFF_SENTINEL).join('').trim()
  return { text, handoff, usage }
}

// ============================================================
// Structured extraction — collects a fixed set of fields from free
// conversation via a forced tool call, one provider round trip per
// customer turn. Consumed by the Flows `collect_ai` node (engine.ts).
// ============================================================

export interface ExtractArgs {
  config: AiConfig
  /** Fields to collect this turn. */
  fields: ExtractionField[]
  /** Already-captured values for some of `fields`, keyed by `key`. */
  knownValues: Record<string, string>
  /** Business-specific instructions merged into the prompt. */
  systemContext?: string
  /** Recent conversation turns, oldest first. */
  messages: ChatMessage[]
}

export interface ExtractResult {
  /** Only the non-empty values the model extracted this call — the
   *  caller merges these into its own known-values map; a field
   *  absent here means the model didn't (re)confirm it this turn. */
  fields: Record<string, string>
  /** Next message to send the customer, or a closing line when `done`. */
  replyText: string
  /** True once the model considers every required field filled. */
  done: boolean
  /** True when the model asked to hand off to a human. */
  handoff: boolean
  usage: AiUsage | null
}

/**
 * Extract whichever configured fields the customer has now provided,
 * and get the next reply in the same call. Dispatches to the right
 * adapter's forced-tool-call variant, then validates the parsed JSON
 * against `fields` so a hallucinated key or wrong-typed value can
 * never leak into `flow_runs.vars`. Throws `AiError` on any
 * provider/network failure or malformed tool response — callers must
 * not let that strand the customer silently (see the Flows engine's
 * handoff-on-error handling for this node).
 */
export async function extractWithReply(args: ExtractArgs): Promise<ExtractResult> {
  const { config, fields, knownValues, systemContext, messages } = args
  const timeoutMs = aiRequestTimeoutMs()
  const schema = buildExtractionSchema(fields)
  const systemPrompt = buildExtractionPrompt({ fields, knownValues, systemContext })
  const providerArgs = {
    apiKey: config.apiKey,
    model: config.model,
    systemPrompt,
    messages,
    timeoutMs,
    schema,
    toolName: EXTRACTION_TOOL_NAME,
  }

  let result: { data: unknown; usage: AiUsage | null }
  switch (config.provider) {
    case 'openai':
      result = await generateOpenAiStructured(providerArgs)
      break
    case 'anthropic':
      result = await generateAnthropicStructured(providerArgs)
      break
    default:
      throw new AiError(`Unsupported AI provider: ${config.provider}`, {
        code: 'unsupported_provider',
        status: 400,
      })
  }

  return parseExtraction(result.data, fields, result.usage)
}

/**
 * Validate + normalize the raw tool-call JSON into `ExtractResult`.
 * Defensive by design (mirrors `parseGeneration`'s pure-function
 * shape for unit testing): an unexpected shape — wrong type, missing
 * key, hallucinated extra field — degrades to "nothing extracted"
 * rather than throwing, since the model call itself already
 * succeeded and the engine should still get a usable (if empty) turn
 * to act on.
 */
export function parseExtraction(
  raw: unknown,
  fields: ExtractionField[],
  usage: AiUsage | null = null,
): ExtractResult {
  const obj = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const extractedRaw = (
    obj.extracted && typeof obj.extracted === 'object' ? obj.extracted : {}
  ) as Record<string, unknown>

  const extracted: Record<string, string> = {}
  for (const f of fields) {
    const v = extractedRaw[f.key]
    if (typeof v === 'string' && v.trim()) {
      extracted[f.key] = v.trim()
    }
  }

  return {
    fields: extracted,
    replyText: typeof obj.reply_text === 'string' ? obj.reply_text.trim() : '',
    done: obj.done === true,
    handoff: obj.handoff === true,
    usage,
  }
}
