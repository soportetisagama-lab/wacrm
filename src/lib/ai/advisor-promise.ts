// ============================================================
// "Un asesor te escribe" filter for the AI auto-reply.
//
// Instagram / Messenger chats are served first by the Community Manager,
// and a WhatsApp contact without a number can't be called back: in both
// cases the bot must never promise that an advisor (or anyone on the
// team) will write, call or contact the customer. The prompt says so
// (NO_ADVISOR_PROMISE_GUIDANCE); this is the deterministic safety net
// after generation: sentences carrying such a promise are removed, and
// the number is asked for instead when it's missing or nothing is left.
//
// Conservative on purpose: questions ("¿quieres hablar con un asesor?",
// "¿quieres que un asesor te llame?") and mentions without a contact verb
// ("un asesor puede ayudarte con eso") are kept.
// ============================================================

import { ASK_PHONE_TEXT } from './awaiting-phone'

// The prompt half lives in ./defaults (NO_ADVISOR_PROMISE_GUIDANCE).

const SUBJECT =
  String.raw`(?:asesor(?:a|es|as)?|ejecutiv[oa]s?|vendedor(?:a|es|as)?|especialistas?|` +
  String.raw`(?:alguien|una persona|un miembro|uno|una)\s+de(?:l|\s+nuestro)?\s+equipo|` +
  String.raw`(?:el|nuestro)\s+equipo(?:\s+de\s+\p{L}+)?)(?![\p{L}])`

/** Contact verbs right after the subject ("te escribe", "se comunicará contigo"). */
const CONTACT_VERB =
  String.raw`(?:(?:te|le|les|lo|la)\s+(?:(?:va|van)\s+a\s+)?(?:escrib\p{L}*|contact\p{L}*|llam\p{L}*|respond\p{L}*|atender(?:[aá]n?)?)` +
  String.raw`|se\s+(?:(?:va|van)\s+a\s+)?(?:comunic\p{L}*|pondr\p{L}*\s+en\s+contacto|pone[n]?\s+en\s+contacto|contact\p{L}*)` +
  String.raw`|(?:va|van)\s+a\s+(?:tomar|continuar|seguir)\s+(?:tu|su|con\s+tu|con\s+su)\s+(?:caso|consulta|solicitud|pedido)` +
  String.raw`|(?:tomar[aá]n?|continuar[aá]n?)\s+(?:tu|su)\s+(?:caso|consulta|solicitud|pedido))`

const PROMISE_RES: RegExp[] = [
  // "un asesor (del equipo) te escribe / contactará / llamará …"
  new RegExp(String.raw`\b${SUBJECT}(?:\s+\p{L}+){0,4}?\s+${CONTACT_VERB}`, 'iu'),
  // "te derivo / te paso / te comunico con un asesor"
  new RegExp(
    String.raw`\b(?:te|le|lo|la)\s+(?:derivo|deriv[eé]|paso|pas[eé]|comunico|transfiero|conecto|voy\s+a\s+(?:derivar|pasar|comunicar|transferir|conectar))\s+(?:con|a)\s+(?:un[ao]?\s+|el\s+|la\s+|nuestr[oa]s?\s+)?${SUBJECT}`,
    'iu',
  ),
  // "derivo / paso tu caso a un asesor"
  new RegExp(
    String.raw`\b(?:derivo|deriv[eé]|paso|pas[eé]|le\s+paso|ya\s+le\s+paso)\s+(?:tu|su)\s+(?:caso|consulta|solicitud|pedido)\s+(?:a|con)\s+(?:un[ao]?\s+|el\s+|la\s+|nuestr[oa]s?\s+)?${SUBJECT}`,
    'iu',
  ),
  // "te contactamos", "te llamaremos", "nos pondremos en contacto"
  new RegExp(
    String.raw`\b(?:te|le|los|las)\s+(?:contactamos|contactaremos|llamamos|llamaremos|escribiremos|vamos\s+a\s+(?:contactar|llamar|escribir))(?![\p{L}])`,
    'iu',
  ),
  new RegExp(
    String.raw`\bnos\s+(?:comunicaremos|pondremos\s+en\s+contacto|contactaremos|vamos\s+a\s+(?:comunicar|poner\s+en\s+contacto))(?![\p{L}])`,
    'iu',
  ),
]

/** Pure: true when this one sentence promises an advisor / a callback. */
export function sentencePromisesAdvisor(sentence: string): boolean {
  const s = sentence.trim()
  if (!s) return false
  // A question offers, it doesn't promise.
  if (/\?\s*\p{Extended_Pictographic}*\s*$/u.test(s) || s.startsWith('¿')) return false
  return PROMISE_RES.some((re) => re.test(s))
}

/** Sentences with their trailing punctuation/space (newlines kept). */
function splitSentences(text: string): string[] {
  return text.match(/[^.!?\n]+[.!?]*[^\S\n]*\n*|[.!?\n]+/gu) ?? [text]
}

export interface AdvisorPromiseFilterResult {
  text: string
  /** Sentences that were taken out (for the log). */
  removed: string[]
}

/**
 * Pure: drop the sentences that promise an advisor. When something was
 * dropped and the contact has no number, or nothing is left, the first
 * dropped sentence becomes ASK_PHONE_TEXT (never twice).
 */
export function filterAdvisorPromises(
  text: string,
  opts: { hasPhone: boolean },
): AdvisorPromiseFilterResult {
  const parts = splitSentences(text)
  const removed: string[] = []
  const kept: string[] = []
  let askAt = -1
  for (const part of parts) {
    if (sentencePromisesAdvisor(part)) {
      removed.push(part.trim())
      if (askAt === -1) askAt = kept.length
      continue
    }
    kept.push(part)
  }
  if (removed.length === 0) return { text, removed }

  const rest = kept.join('').trim()
  const needsAsk = (!opts.hasPhone || !rest) && !rest.includes(ASK_PHONE_TEXT)
  if (needsAsk) kept.splice(askAt, 0, `${ASK_PHONE_TEXT} `)
  const out = kept
    .join('')
    .replace(/[^\S\n]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[^\S\n]{2,}/g, ' ')
    .trim()
  return { text: out || ASK_PHONE_TEXT, removed }
}
