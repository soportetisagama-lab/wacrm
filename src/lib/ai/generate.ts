import {
  AiError,
  type AiConfig,
  type AiDocument,
  type AiUsage,
  type ChatMessage,
  type GenerateResult,
} from './types'
import { HANDOFF_SENTINEL, SEND_DOCUMENT_SENTINEL_RE, aiRequestTimeoutMs } from './defaults'
import {
  buildExtractionPrompt,
  buildExtractionSchema,
  EXTRACTION_TOOL_NAME,
  type DocumentOption,
  type ExtractionField,
} from './schema'
import { generateOpenAi, generateOpenAiStructured } from './providers/openai'
import { generateAnthropic, generateAnthropicStructured } from './providers/anthropic'

export interface GenerateArgs {
  config: AiConfig
  /** Fully-built system prompt (see `buildSystemPrompt`) — already
   *  includes the document-catalog instructions when relevant; this
   *  module never builds prompt text itself. */
  systemPrompt: string
  /** Recent conversation turns, oldest first. */
  messages: ChatMessage[]
  /** Same catalog passed to `buildSystemPrompt` — used here only to
   *  validate a `[[SEND_DOCUMENT:key]]` sentinel's key, not to build
   *  any prompt text (the caller already did that). Omit/empty means
   *  `sendDocument` is always null in the result. */
  documents?: AiDocument[]
}

/**
 * Generate the next reply from the account's configured provider.
 * Dispatches to the right adapter, then parses the handoff sentinel out
 * of the raw text. Throws `AiError` on any provider/network failure.
 */
export async function generateReply(args: GenerateArgs): Promise<GenerateResult> {
  const { config, systemPrompt, messages, documents = [] } = args
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

  return parseGeneration(
    result.text,
    documents.map((d) => d.key),
    result.usage,
  )
}

/**
 * Split the raw model output into `{ text, handoff, sendDocument,
 * usage }`. Both sentinels can appear alone or trailing a partial
 * reply; either way they're stripped from the remaining text.
 * `[[SEND_DOCUMENT:key]]`'s key is validated against `documentKeys` —
 * a hallucinated or stale key (not in the list) degrades to `null`,
 * same defensive philosophy as `parseExtraction`'s field validation.
 * `usage` is passed straight through (null when the provider didn't
 * report it).
 */
export function parseGeneration(
  raw: string,
  documentKeys: string[] = [],
  usage: AiUsage | null = null,
): GenerateResult {
  const handoff = raw.includes(HANDOFF_SENTINEL)
  const docMatch = raw.match(SEND_DOCUMENT_SENTINEL_RE)
  const sendDocument = docMatch && documentKeys.includes(docMatch[1]) ? docMatch[1] : null
  const text = raw
    .split(HANDOFF_SENTINEL)
    .join('')
    .replace(SEND_DOCUMENT_SENTINEL_RE, '')
    .trim()
  return { text, handoff, sendDocument, usage }
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
  /** Documents this node can send on request (Opción B). Omit/empty —
   *  the default — means the schema never offers a `send_document`
   *  slot at all, so this call behaves exactly as before this existed. */
  documents?: DocumentOption[]
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
  /** The document key the model asked to send, or null. Always null
   *  when `documents` was empty/omitted — there's no schema slot for
   *  the model to have set in the first place. Validated against the
   *  known keys (see `parseExtraction`) so a hallucinated key can
   *  never reach the engine's send-document step. */
  sendDocument: string | null
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
  const { config, fields, knownValues, systemContext, messages, documents = [] } = args
  const timeoutMs = aiRequestTimeoutMs()
  const schema = buildExtractionSchema(fields, documents)
  const systemPrompt = buildExtractionPrompt({ fields, knownValues, systemContext, documents })
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

  return parseExtraction(result.data, fields, documents, result.usage)
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
  documents: DocumentOption[] = [],
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

  // Defensive, same philosophy as `extracted` above: a hallucinated or
  // stale key (e.g. `documents` changed between the schema being built
  // and this response) degrades to "nothing to send" rather than
  // reaching the engine's send-document step with an unknown key.
  const documentKeys = new Set(documents.map((d) => d.key))
  const sendDocument =
    typeof obj.send_document === 'string' && documentKeys.has(obj.send_document)
      ? obj.send_document
      : null

  return {
    fields: extracted,
    replyText: typeof obj.reply_text === 'string' ? obj.reply_text.trim() : '',
    done: obj.done === true,
    handoff: obj.handoff === true,
    sendDocument,
    usage,
  }
}
