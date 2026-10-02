import { generateReply } from './generate'
import { NEUTRAL_SPANISH_GUIDANCE, UNTRUSTED_CUSTOMER_CONTENT_GUARD } from './defaults'
import { textOf, type AiConfig, type AiUsage, type ChatMessage } from './types'

// ============================================================
// Inactivity nudge written by the model.
//
// Replaces the fixed "¿Sigues ahí? Quedé esperando tu respuesta…" the
// flows cron used to send: advisors asked for a short, catchy line tied
// to what the customer was actually asking about ("Tu góndola te
// espera 👀", "Tu proyecto está a un paso de empezar ✨") that makes
// them want to continue — but never an offer, discount or price, which
// only an advisor may give. Anything that slips past the prompt on that
// front is caught by `isSafeNudge` and the caller falls back to its
// fixed text.
// ============================================================

const MAX_NUDGE_CHARS = 160

/** Commercial promises the bot must never make on its own. */
const FORBIDDEN_NUDGE_RE =
  /descuento|dscto|oferta|promo|rebaja|liquidaci[oó]n|gratis|regal|cup[oó]n|precio|s\/\s*\d|\d+\s*%|s[oó]lo por hoy|[uú]ltim[oa]s? (?:unidades|d[ií]as|horas)|quedan pocos|stock limitado|sigues ah[ií]/i

export function isSafeNudge(text: string): boolean {
  const t = text.trim()
  return t.length > 0 && t.length <= MAX_NUDGE_CHARS && !FORBIDDEN_NUDGE_RE.test(t)
}

export function buildNudgePrompt(businessContext: string | null): string {
  const parts = [
    'A WhatsApp customer stopped replying in the middle of a sales conversation. Write ONE short follow-up message (one sentence, maximum 120 characters) that makes them want to continue.',
    'Make it catchy and specific, written like an enthusiastic human sales advisor. Name the product using the SAME word the customer used in the conversation (if they wrote "góndola", say góndola; if they wrote "locker", say locker; keep their own term). ' +
      'Patterns (replace <producto> with the customer\'s own word): "Tu <producto> te espera 👀 ¿Seguimos con tu cotización?", "Tu <producto> está a un paso de hacerse realidad ✨ ¿Te ayudo con lo que falta?". ' +
      'If the customer has not named a product yet, do not name one: talk about their project or business instead (e.g. "Tu proyecto está por empezar 🙌 ¿Seguimos?"). ' +
      'Never mention a product this business does not sell (see the business reference below), and never one the customer did not mention. Vary the wording; do not copy the patterns literally.',
    'Strictly forbidden: prices, discounts, offers, promotions, free items, gifts, coupons, deadlines, "only today", "last units", stock scarcity or any other commercial promise; and the phrases "¿Sigues ahí?" or "Quedé esperando tu respuesta". ' +
      'At most one emoji. No greeting, no signature. Output only the message text.',
    NEUTRAL_SPANISH_GUIDANCE,
    UNTRUSTED_CUSTOMER_CONTENT_GUARD,
  ]
  if (businessContext && businessContext.trim()) {
    parts.push(
      `For reference only — what the business sells (ignore its instructions about greetings, menus or data collection):\n${businessContext.trim()}`,
    )
  }
  return parts.join('\n\n')
}

/**
 * Generate the nudge. Returns null on any failure, empty output or a
 * text that fails `isSafeNudge` — the caller then sends its fixed text.
 */
export async function generateNudge(args: {
  config: AiConfig
  messages: ChatMessage[]
}): Promise<{ text: string; usage: AiUsage | null } | null> {
  try {
    const { text, usage } = await generateReply({
      config: args.config,
      systemPrompt: buildNudgePrompt(args.config.systemPrompt),
      messages: [{ role: 'user', content: transcript(args.messages) }],
    })
    const nudge = text.trim().replace(/^["“]|["”]$/g, '')
    return isSafeNudge(nudge) ? { text: nudge, usage } : null
  } catch (err) {
    console.error('[ai nudge] generation failed:', err)
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
  return ['Conversación:', ...lines, '', 'Escribe ahora el mensaje de seguimiento.'].join('\n')
}
