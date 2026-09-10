// ============================================================
// Shared types for the AI reply assistant (bring-your-own-key).
//
// One small provider-agnostic surface so the inbox draft route and the
// inbound auto-reply bot both talk to `generateReply` without caring
// whether the account is on OpenAI or Anthropic.
// ============================================================

export type AiProvider = 'openai' | 'anthropic'

/**
 * One document an AI assistant can send mid-conversation on request
 * (Opción B — a real WhatsApp media message, not just a text link).
 * Shared shape for both homes this can live in: `AiConfig.documents`
 * (account-wide, general auto-reply assistant) and
 * `CollectAiNodeConfig.documents` (lib/flows/types.ts, per flow node)
 * — same catalog shape, two separate config stores (a node is scoped
 * to one flow; the account has no single node to borrow from).
 */
export interface AiDocument {
  /** Stable id the model matches against — e.g. "catalogo". Not a
   *  `flow_runs.vars` key; never merged into vars. */
  key: string
  /** Short human-readable name shown to the model so it knows what
   *  this key means and when to offer it — e.g. "Catálogo de
   *  productos". Not shown to the customer. */
  label: string
  media_type: 'image' | 'video' | 'document'
  /** Public URL Meta will fetch. */
  media_url: string
  caption?: string
  /** Documents only — Meta ignores it for image/video. */
  filename?: string
}

/**
 * Account AI setup, decrypted and ready to use. Produced by
 * `loadAiConfig` — `apiKey` is the plaintext BYO provider key
 * (stored AES-256-GCM-encrypted at rest).
 */
export interface AiConfig {
  provider: AiProvider
  model: string
  apiKey: string
  systemPrompt: string | null
  isActive: boolean
  autoReplyEnabled: boolean
  autoReplyMaxPerConversation: number
  /** Where auto-reply hands a conversation off when the model bails: an
   *  agent's `auth.users.id`, or null to leave it unassigned (drop into
   *  the shared queue). */
  handoffAgentId: string | null
  /** Optional OpenAI-compatible key for embeddings. When set, the
   *  knowledge base is embedded and semantic retrieval turns on; when
   *  null, retrieval falls back to lexical full-text search. */
  embeddingsApiKey: string | null
  /** Opt-in switch for Whisper voice-note transcription. Off by
   *  default (real per-audio cost); also requires `embeddingsApiKey`
   *  to be set to actually run — callers must check both. Not wired to
   *  anything yet (piece 2a: schema + config plumbing only). */
  transcribeAudioEnabled: boolean
  /** Opt-in switch for sending images to the model as vision content.
   *  Off by default — image tokens cost meaningfully more than text.
   *  Unlike `transcribeAudioEnabled`, no secondary key dependency: uses
   *  the account's own chat provider/model. */
  visionEnabled: boolean
  /** Account-wide document catalog the general auto-reply assistant
   *  can send on request (`[[SEND_DOCUMENT:key]]`, auto_reply mode
   *  only — see `buildSystemPrompt`/`parseGeneration`). Empty array
   *  when unconfigured — behaves exactly as before this existed. */
  documents: AiDocument[]
}

/**
 * One piece of message content. `image.base64` is already-encoded and
 * ready to send — downloading media and encoding it is the caller's
 * job (see `buildConversationContext`), not the provider adapters', so
 * an image message is just a plain data blob by the time it gets here.
 */
export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; mimeType: string; base64: string }

/**
 * A single conversation turn in the shape both providers accept.
 * `content` is a plain string for the (still-common) text-only case;
 * a message carrying an image uses `ContentBlock[]` instead — e.g. an
 * image with a caption is `[{type:'image', ...}, {type:'text', ...}]`.
 */
export interface ChatMessage {
  role: 'user' | 'assistant'
  content: string | ContentBlock[]
}

/**
 * The text portion of a message's content, regardless of shape —
 * plain string as-is, or every `text` block joined (dropping image
 * blocks). Used wherever we need "what the customer said" as a single
 * string: RAG queries (`latestUserMessage`), handoff summaries. Empty
 * when there's no text at all (e.g. an image with no caption) — that's
 * a legitimate result, not an error; callers decide what to do with it.
 */
export function textOf(content: string | ContentBlock[]): string {
  if (typeof content === 'string') return content
  return content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
}

/**
 * Token counts for one provider call, normalized across OpenAI
 * (`prompt`/`completion`) and Anthropic (`input`/`output`). Null when
 * the provider didn't return usage. Logged to `ai_usage_log`.
 */
export interface AiUsage {
  promptTokens: number
  completionTokens: number
  totalTokens: number
}

/** Raw text + usage a provider adapter returns before handoff parsing. */
export interface ProviderResult {
  text: string
  usage: AiUsage | null
}

/** Outcome of a generation call. */
export interface GenerateResult {
  /** The reply text, with any handoff/send-document sentinel stripped. */
  text: string
  /** True when the model asked to hand off to a human (auto-reply mode). */
  handoff: boolean
  /** The document key the model asked to send (`[[SEND_DOCUMENT:key]]`),
   *  or null. Always null when no `documents` were passed to
   *  `parseGeneration` — there's nothing to validate the key against.
   *  Validated so a hallucinated key can never reach the caller's
   *  send-document step. */
  sendDocument: string | null
  /** Provider token usage for this call, or null when unavailable. */
  usage: AiUsage | null
}

/**
 * Typed error for every AI failure mode. `status` maps cleanly to an
 * HTTP response in the draft route; `code` lets the UI/tests branch
 * (invalid_key vs rate_limited vs timeout, etc.).
 */
export class AiError extends Error {
  readonly code: string
  readonly status: number
  constructor(message: string, opts: { code?: string; status?: number } = {}) {
    super(message)
    this.name = 'AiError'
    this.code = opts.code ?? 'ai_error'
    this.status = opts.status ?? 502
  }
}
