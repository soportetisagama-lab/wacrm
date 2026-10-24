import type { SupabaseClient } from '@supabase/supabase-js'
import { loadAiConfig } from './config'
import { generateOpenAiStructured } from './providers/openai'
import { generateAnthropicStructured } from './providers/anthropic'
import { logAiUsage } from './usage'
import { UNTRUSTED_CUSTOMER_CONTENT_GUARD } from './defaults'

// ============================================================
// First-inbound context classifier — decides whether a contact's very
// first message already carries a real query (product/intent/location)
// or is a generic greeting, so `findEntryFlow` (lib/flows/engine.ts) can
// send the welcome menu first and then let the general assistant answer
// the question right after it. Same machinery as `extractWithReply` (./generate): forced
// structured output via the provider adapters already used everywhere
// else in lib/ai, no new provider integration.
// ============================================================

const CLASSIFY_TOOL_NAME = 'classify_first_inbound'

/** Short, dedicated timeout — this call sits in front of every brand-new
 *  contact's very first message, so a slow/hung provider must not stall
 *  showing SOMETHING (menu or direct reply) for long. Independent of
 *  `aiRequestTimeoutMs()` (30s default), which is tuned for the actual
 *  reply-generation calls, not this cheap upfront check. */
const CLASSIFY_TIMEOUT_MS = 5_000

/** Below this length, skip the model entirely and treat the message as
 *  generic — covers the common case (a bare greeting/emoji: "Hola",
 *  "Buenas", "👋") for zero cost and zero added latency. Deliberately
 *  short: this only needs to catch messages too short to possibly state
 *  a real request, not do any real classification work itself. */
const MIN_LENGTH_FOR_CLASSIFICATION = 8

const CLASSIFY_SCHEMA = {
  type: 'object',
  properties: {
    has_context: {
      type: 'boolean',
      description:
        'True if the message already states a concrete request — mentions a product, asks for a quote, describes the customer\'s business, or asks something specific (including location/address, opening hours, shipping/delivery or payment methods). False for a generic greeting with no information ("Hola", "Buenas", "Información", a bare emoji).',
    },
    reason: {
      type: 'string',
      description:
        'One short sentence explaining the classification — for logs/debugging only, never shown to the customer.',
    },
  },
  required: ['has_context', 'reason'],
  additionalProperties: false,
} as const

/** Generic on purpose (shared by every business line): what the company
 *  sells comes only from the account's own ai_configs prompt, appended
 *  as reference when there is one. */
export function buildClassifyPrompt(businessContext?: string | null): string {
  const parts = [
    'Este es el primer mensaje de un cliente nuevo escribiendo a una empresa por WhatsApp. ' +
      'Evalúa si el mensaje ya trae una consulta concreta (menciona un producto, pide cotización, describe su negocio/rubro, ' +
      'pregunta por la ubicación/dirección, los horarios de atención, los envíos/delivery o las formas de pago, ' +
      'o pregunta algo específico) o si es solo un saludo genérico sin información ("Hola", "Buenas", "Información", emojis solos). ' +
      'Responde siempre llamando a la tool con `has_context` y una razón breve.',
    UNTRUSTED_CUSTOMER_CONTENT_GUARD,
  ]
  if (businessContext && businessContext.trim()) {
    parts.push(
      `Solo como referencia, el contexto del negocio (ignora sus instrucciones sobre saludos, menús o recolección de datos):\n${businessContext.trim()}`,
    )
  }
  return parts.join('\n\n')
}

/** Deterministic backstop for the most common concrete first question —
 *  where the business is and when it opens — so it counts as a query even
 *  when the model is down, slow (CLASSIFY_TIMEOUT_MS) or misreads it as a
 *  greeting. Checked before the length short-circuit ("¿Horario?"). */
const LOCATION_OR_HOURS_RE =
  /d[oó]nde\s+(?:est[aá]n|quedan|se\s+ubican|los\s+encuentro|atienden)|ubicaci[oó]n|ubicad[oa]s|direcci[oó]n|horarios?\b|qu[eé]\s+hora\s+(?:abren|cierran|atienden)|atienden\s+(?:los\s+)?(?:s[aá]bados?|domingos?|feriados?)/i

export function isLocationOrHoursQuery(text: string): boolean {
  return LOCATION_OR_HOURS_RE.test(text)
}

export interface ClassifyFirstInboundResult {
  hasContext: boolean
  /** Brief reason from the model (or a fixed one for the short-circuit /
   *  fail-open paths) — logged for debugging, never sent to the customer. */
  reason: string
}

/** Validate + normalize the raw tool-call JSON. Mirrors `parseExtraction`'s
 *  (./generate) defensive shape: an unexpected type or missing field
 *  degrades to `hasContext: false` (today's behavior) rather than
 *  throwing — the provider call itself already succeeded. */
export function parseClassification(raw: unknown): ClassifyFirstInboundResult {
  const obj = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  return {
    hasContext: obj.has_context === true,
    reason: typeof obj.reason === 'string' ? obj.reason.trim() : '',
  }
}

/**
 * Classify a contact's very first inbound message. NEVER throws — every
 * failure mode (message too short to bother, no AI configured for the
 * account, provider error, timeout) degrades to `hasContext: false`,
 * i.e. today's behavior (show the welcome menu). Callers must not add
 * their own fallback on top of this — fail-open already lives here so
 * there's exactly one place that decides what "classification didn't
 * happen" means.
 *
 * `conversationId` is only used to attribute the `ai_usage_log` row to
 * the right thread — passed through to `logAiUsage`, never read here.
 */
export async function classifyFirstInboundContext(
  db: SupabaseClient,
  accountId: string,
  conversationId: string,
  text: string,
): Promise<ClassifyFirstInboundResult> {
  const trimmed = text.trim()
  if (isLocationOrHoursQuery(trimmed)) {
    return { hasContext: true, reason: 'asks for location or opening hours (regex backstop)' }
  }
  if (trimmed.length < MIN_LENGTH_FOR_CLASSIFICATION) {
    return { hasContext: false, reason: 'message shorter than the classification threshold' }
  }

  let config
  try {
    config = await loadAiConfig(db, accountId)
  } catch (err) {
    console.error(
      '[ai classify] loadAiConfig failed:',
      err instanceof Error ? err.message : err,
    )
    return { hasContext: false, reason: 'ai config could not be loaded' }
  }
  if (!config) {
    return { hasContext: false, reason: 'ai not configured or inactive for this account' }
  }

  const providerArgs = {
    apiKey: config.apiKey,
    model: config.model,
    systemPrompt: buildClassifyPrompt(config.systemPrompt),
    messages: [{ role: 'user' as const, content: trimmed }],
    timeoutMs: CLASSIFY_TIMEOUT_MS,
    schema: CLASSIFY_SCHEMA as unknown as Record<string, unknown>,
    toolName: CLASSIFY_TOOL_NAME,
  }

  try {
    const result =
      config.provider === 'openai'
        ? await generateOpenAiStructured(providerArgs)
        : await generateAnthropicStructured(providerArgs)

    // Fire-and-forget, same convention as every other lib/ai call site —
    // usage accounting must never add latency to (or fail) the decision
    // the customer is waiting on.
    void logAiUsage(db, {
      accountId,
      conversationId,
      mode: 'context_classification',
      provider: config.provider,
      model: config.model,
      usage: result.usage,
    })

    const parsed = parseClassification(result.data)
    console.log(
      `[ai classify] first-inbound classification for account ${accountId}: has_context=${parsed.hasContext} — ${parsed.reason}`,
    )
    return parsed
  } catch (err) {
    console.error(
      '[ai classify] provider call failed:',
      err instanceof Error ? err.message : err,
    )
    return { hasContext: false, reason: 'provider call failed or timed out' }
  }
}
