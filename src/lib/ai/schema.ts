import { UNTRUSTED_CUSTOMER_CONTENT_GUARD } from './defaults'

// ============================================================
// Structured extraction — one field a `collect_ai` flow node (or any
// future caller) wants filled from free-text conversation. Reused by
// `extractWithReply` in ./generate and by the Flows engine (not yet
// built) that drives the collection sub-loop.
// ============================================================

/**
 * One field to collect. `key` becomes the `flow_runs.vars[key]` entry
 * once captured — same identifier rules as `collect_input`'s
 * `var_key` (alphanumeric + underscore, starting with a letter or
 * underscore; enforced by the Flows validator, not here).
 */
export interface ExtractionField {
  key: string
  label: string
  description?: string
  required: boolean
}

/**
 * One document a `collect_ai` node can send mid-conversation on
 * request (Opción B — real document send, not just a text link).
 * Deliberately minimal — just enough for the extraction prompt to
 * describe the option to the model. The full send-time shape
 * (media_type/media_url/caption/filename) lives on
 * `CollectAiNodeConfig.documents` (lib/flows/types.ts), which this
 * module never imports — lib/ai/* stays flow-agnostic; the engine
 * maps its own config down to this shape before calling in.
 */
export interface DocumentOption {
  /** Stable id — matched against `CollectAiNodeConfig.documents[].key`. */
  key: string
  /** Short human-readable name, e.g. "Catálogo de productos". */
  label: string
}

/** Name of the single tool both providers are forced to call. */
export const EXTRACTION_TOOL_NAME = 'submit'

/**
 * JSON Schema for the forced tool call both providers are asked to
 * make. Every extracted field is typed nullable + listed in
 * `required` — the *key* must appear in the response, but its value
 * may be `null` when the customer hasn't provided it yet. This is
 * OpenAI's documented shape for strict structured outputs with
 * effectively-optional fields (`strict: true` requires every property
 * to be in `required`), and Anthropic accepts the same JSON Schema
 * without needing that workaround.
 */
export function buildExtractionSchema(
  fields: ExtractionField[],
  documents: DocumentOption[] = [],
): Record<string, unknown> {
  const extractedProps: Record<string, unknown> = {}
  for (const f of fields) {
    extractedProps[f.key] = {
      type: ['string', 'null'],
      description: f.description || f.label,
    }
  }
  const properties: Record<string, unknown> = {
    extracted: {
      type: 'object',
      properties: extractedProps,
      required: fields.map((f) => f.key),
      additionalProperties: false,
    },
    reply_text: {
      type: 'string',
      description:
        'The next message to send the customer — a targeted question about the still-missing required fields, or a short closing confirmation once done is true.',
    },
    done: {
      type: 'boolean',
      description:
        'True once every required field has a confirmed, non-guessed value.',
    },
    handoff: {
      type: 'boolean',
      description:
        'True if the customer should be handed off to a human instead of continuing this collection (explicitly asked for a person, upset, or stuck off-topic).',
    },
  }
  const required = ['extracted', 'reply_text', 'done', 'handoff']

  // Only present in the schema at all when the node actually offers
  // documents — an empty list means the model is never even given the
  // option, rather than always having a `send_document` slot it must
  // reason about (and strict mode requires every present property to
  // be in `required`, so this can't be a harmlessly-unused field).
  if (documents.length > 0) {
    properties.send_document = {
      type: ['string', 'null'],
      enum: [...documents.map((d) => d.key), null],
      description:
        'Set to the matching document key when the customer explicitly asks for one of the documents listed in the prompt; otherwise null. Sending happens automatically — this is a signal, not the reply itself.',
    }
    required.push('send_document')
  }

  return {
    type: 'object',
    properties,
    required,
    additionalProperties: false,
  }
}

/**
 * System prompt for the extraction call. Tells the model which
 * fields are still missing vs. already known — so it stops asking
 * about fields that are already answered — and reuses the same
 * anti-injection guard as the draft/auto-reply assistant.
 */
export function buildExtractionPrompt(args: {
  fields: ExtractionField[]
  /** Already-captured values for some of `fields`, keyed by `key`. */
  knownValues: Record<string, string>
  /** Business-specific instructions, e.g. valid categories/options. */
  systemContext?: string
  /** Documents this node can send on request — mirrors `documents` in
   *  buildExtractionSchema; omit/empty means no `send_document` slot
   *  exists in the schema at all, so this has nothing to describe. */
  documents?: DocumentOption[]
}): string {
  const { fields, knownValues, systemContext, documents } = args
  const known = fields.filter((f) => knownValues[f.key]?.trim())
  const missing = fields.filter((f) => !knownValues[f.key]?.trim())

  const parts: string[] = [
    'You are a customer-messaging assistant for a business that uses a WhatsApp CRM. ' +
      'You are collecting a fixed set of details from a customer through natural conversation, ' +
      'then handing the completed summary to a human agent. ' +
      'You are shown the recent WhatsApp conversation between the business (assistant) and the customer (user). ' +
      'Always respond by calling the `submit` tool — never reply in plain text.',
    `Fields to collect:\n${fields
      .map(
        (f) =>
          `- ${f.key} (${f.required ? 'required' : 'optional'}): ${f.description || f.label}`,
      )
      .join('\n')}`,
  ]

  if (known.length > 0) {
    parts.push(
      `Already collected — do not ask about these again unless the customer contradicts them:\n${known
        .map((f) => `- ${f.key}: ${knownValues[f.key]}`)
        .join('\n')}`,
    )
  }
  if (missing.length > 0) {
    parts.push(`Still missing:\n${missing.map((f) => `- ${f.key}`).join('\n')}`)
  }

  parts.push(
    'In `extracted`, return ONLY new or updated values you are confident about from the latest customer message and the conversation so far — leave a field null if the customer has not actually provided it; never guess. ' +
      '`reply_text` is the next message to send: reply in the same language the customer is writing in, keep it concise and friendly (suitable for WhatsApp), and ask only about the still-missing required fields — do not repeat what you already have. ' +
      'Set `done: true` only once every required field has a real value; in that case `reply_text` should be a short closing confirmation, not another question. ' +
      "Set `handoff: true` if the customer explicitly asks for a human, seems upset, or the conversation has gone somewhere you cannot resolve by collecting these fields — prefer handing off over guessing or over-probing.",
  )

  if (documents && documents.length > 0) {
    parts.push(
      `Documents you can send on request:\n${documents
        .map((d) => `- ${d.key}: ${d.label}`)
        .join('\n')}\n` +
        'Set `send_document` to the matching key ONLY when the customer explicitly asks for one of these (e.g. "¿tendrían catálogo?"); otherwise leave it null. ' +
        'Sending happens automatically outside this call — do not paste a link, mention a URL, or say you are attaching anything; `reply_text` should just continue the conversation naturally (a short confirmation and/or your next question).',
    )
  }

  parts.push(UNTRUSTED_CUSTOMER_CONTENT_GUARD)

  if (systemContext && systemContext.trim()) {
    parts.push(`Business context and instructions:\n${systemContext.trim()}`)
  }

  return parts.join('\n\n')
}
