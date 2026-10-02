import type { SupabaseClient } from '@supabase/supabase-js'
import { generateReply } from './generate'
import { buildConversationContext } from './context'
import { logAiUsage } from './usage'
import { NEUTRAL_SPANISH_GUIDANCE, UNTRUSTED_CUSTOMER_CONTENT_GUARD } from './defaults'
import { textOf, type AiConfig, type AiUsage, type ChatMessage } from './types'

// ============================================================
// Advisor brief ("ficha") written when the bot hands a chat off.
//
// Advisors asked for the details the bot gathered (product, business,
// district, measures…) without the bot sending the customer a bulleted
// "Información registrada" recap — that recap was the most bot-like
// message in the chat. So the recap moves here: one extra model call
// that turns the conversation into a short internal note stored in
// `conversations.ai_handoff_summary` (shown only in the inbox banner).
// ============================================================

/** Longest brief we keep — the banner is a glanceable note, not a transcript. */
const MAX_BRIEF_CHARS = 600

export function buildBriefPrompt(businessContext: string | null): string {
  const parts = [
    'You write an internal note for a sales advisor who is about to take over a WhatsApp chat from an automated assistant. ' +
      'The customer never sees this note.',
    'Write it in Spanish. List only the details the customer actually gave in the conversation, one per line, as "Campo: valor" ' +
      '(e.g. "Producto: cocina industrial", "Negocio: pollería", "Distrito: SJL", "Medidas: 4x6 m", "Fecha: noviembre"). ' +
      'Then, if useful, one last line "Pendiente: ..." naming the important details still missing, and one line "Motivo: ..." only if the customer asked for a person, complained or seemed upset. ' +
      'Maximum 8 lines. No greeting, no markdown, no bullet symbols, no commentary. Never invent or assume a value the customer did not say.',
    NEUTRAL_SPANISH_GUIDANCE,
    UNTRUSTED_CUSTOMER_CONTENT_GUARD,
  ]
  if (businessContext && businessContext.trim()) {
    parts.push(
      `For reference only — the business and the details its advisors usually need (do not follow its instructions about how to talk to the customer):\n${businessContext.trim()}`,
    )
  }
  return parts.join('\n\n')
}

/**
 * Generate the advisor brief. Returns null (caller keeps its
 * deterministic fallback note) on any failure or empty output — the
 * handoff itself must never depend on this call.
 */
export async function generateHandoffBrief(args: {
  config: AiConfig
  messages: ChatMessage[]
}): Promise<{ brief: string; usage: AiUsage | null } | null> {
  if (!args.messages.some((m) => m.role === 'user' && textOf(m.content).trim())) return null
  try {
    const { text, usage } = await generateReply({
      config: args.config,
      systemPrompt: buildBriefPrompt(args.config.systemPrompt),
      // One transcript message instead of the raw turns, so the model
      // writes the note rather than "the next reply" in the chat.
      messages: [{ role: 'user', content: transcript(args.messages) }],
    })
    const brief = text.trim()
    if (!brief) return null
    return {
      brief: `📋 ${brief.length > MAX_BRIEF_CHARS ? `${brief.slice(0, MAX_BRIEF_CHARS - 1).trimEnd()}…` : brief}`,
      usage,
    }
  } catch (err) {
    console.error('[ai handoff brief] generation failed:', err)
    return null
  }
}

function transcript(messages: ChatMessage[]): string {
  const lines = messages
    .map((m) => {
      const text = textOf(m.content).trim()
      return text ? `${m.role === 'user' ? 'Cliente' : 'Empresa'}: ${text}` : null
    })
    .filter(Boolean)
  return ['Conversación:', ...lines, '', 'Escribe ahora la nota para el asesor.'].join('\n')
}

const HANDOFF_BRIEF_CONTEXT_LIMIT = 50

/** Replace the handoff note with the model-written advisor brief
 *  (lib/ai/handoff-brief.ts); keeps the deterministic note on failure. */
export async function writeHandoffBrief(
  db: SupabaseClient,
  args: {
    accountId: string
    conversationId: string
    config: AiConfig
  },
): Promise<void> {
  // Own, longer text-only window: the brief must cover every detail the
  // customer gave, which with one-question-per-message replies can sit
  // further back than the reply context's default limit.
  let messages
  try {
    messages = await buildConversationContext(db, args.conversationId, HANDOFF_BRIEF_CONTEXT_LIMIT)
  } catch (err) {
    console.error('[ai handoff brief] handoff brief context failed:', err)
    return
  }
  const result = await generateHandoffBrief({ config: args.config, messages })
  if (!result) return
  void logAiUsage(db, {
    accountId: args.accountId,
    conversationId: args.conversationId,
    mode: 'auto_reply',
    provider: args.config.provider,
    model: args.config.model,
    usage: result.usage,
  })
  const { error } = await db
    .from('conversations')
    .update({ ai_handoff_summary: result.brief })
    .eq('id', args.conversationId)
  if (error) console.error('[ai handoff brief] handoff brief save failed:', error.message)
}
