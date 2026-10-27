// ============================================================
// What the customer answered while a handoff waits for their number
// (lib/ai/awaiting-phone.ts) — same logic for WhatsApp without a number
// and for Instagram / Messenger DMs.
//
// The auto-reply reads the whole burst since the bot last wrote (the
// debounce already merges a flurry of messages into one turn) and
// classifies it here. Pure, so every case is unit-tested.
//
// Counting (MAX_PHONE_ASKS = 3, then hand off without the number):
//   - counts: an answer with no number at all ("quiero una cocina",
//     "este mismo", "el de WhatsApp") and the same correction twice in
//     a row (e.g. the same incomplete number again);
//   - doesn't count: a real attempt that needs fixing (incomplete,
//     several numbers, landline, foreign without "+"), a question (the AI
//     answers it and asks again in one line), media, audio without
//     transcript, and acknowledgements ("ok", "gracias", "👍" — no new ask);
//   - hard cap: MAX_HELD_TURNS bot turns in total, whatever they were.
// Refusals ("no quiero dar mi número", "prefiero por aquí") and insults
// hand off right away without the number: the team follows up in the
// same chat, nobody is promised a call.
// ============================================================

import { classifyTypedPhone } from '@/lib/whatsapp/phone-utils'
import { ASK_PHONE_TEXT } from './awaiting-phone'

/** Every bot turn spent waiting for the number, then hand off anyway. */
export const MAX_HELD_TURNS = 8

export const PHONE_INCOMPLETE_TEXT = 'Parece que el número está incompleto 🙏 ¿Nos lo envías de nuevo con los 9 dígitos?'
export const PHONE_MULTIPLE_TEXT = '¿Cuál de esos números es tu celular? 🙏 Envíanos solo uno.'
export const PHONE_FOREIGN_TEXT =
  'Si tu número es de otro país, envíanoslo con el signo + y el código de país, por ejemplo: +54 9 11 1234 5678 🙏'
export const PHONE_LANDLINE_TEXT =
  'Ese parece un número fijo 🙏 ¿Nos compartes tu número de celular? Son 9 dígitos y empieza con 9.'
export const PHONE_SAME_NUMBER_TEXT =
  'Por este chat no nos aparece tu número 🙏 ¿Nos lo escribes aquí, por favor? Son 9 dígitos.'
export const PHONE_MEDIA_TEXT = 'No podemos leer el número en imágenes o archivos 🙏 ¿Nos lo escribes aquí, por favor?'
export const PHONE_AUDIO_TEXT = 'Por aquí no podemos escuchar audios 🙏 ¿Nos escribes tu número de celular?'
/** Customer declined to give the number: the chat goes on here. */
export const PHONE_REFUSED_TEXT =
  'Entendido, no hay problema 😊 Dejamos tu consulta registrada y seguimos por este mismo chat.'
export const PHONE_UPSET_TEXT = 'Entendido. Dejamos tu consulta registrada y seguimos por este mismo chat.'

/** Every text the bot uses to ask for the number (for "already asked?"). */
export const PHONE_ASK_TEXTS = [
  ASK_PHONE_TEXT,
  PHONE_INCOMPLETE_TEXT,
  PHONE_MULTIPLE_TEXT,
  PHONE_FOREIGN_TEXT,
  PHONE_LANDLINE_TEXT,
  PHONE_SAME_NUMBER_TEXT,
  PHONE_MEDIA_TEXT,
  PHONE_AUDIO_TEXT,
]

export interface HeldBurstItem {
  type: 'text' | 'audio' | 'image' | 'sticker' | 'media'
  /** Text, or the audio transcript; null when there is none. */
  text: string | null
}

export type HeldReply =
  | { kind: 'phone'; phone: string }
  | { kind: 'incomplete' | 'multiple' | 'foreign_no_plus' | 'landline' }
  | { kind: 'refusal' | 'insult' | 'same_number' | 'question' | 'ack' | 'media' | 'audio' | 'other' }

const INSULT_RE =
  /(?<![\p{L}])(?:idiota|imb[eé]cil|est[uú]pid[oa]s?|mierda|carajo|conchatumadre|concha\s+de\s+tu|ctm|csm|huev[oó]n|cojud[oa]|pendej[oa]|malparid[oa]|put[ao]s?|j[oó]dete|maldit[oa]s?|basura|in[uú]til(?:es)?|ladr[oó]n(?:es)?|estafador(?:es)?)(?![\p{L}])/iu

const REFUSAL_RE = new RegExp(
  [
    String.raw`no\s+(?:quiero|deseo|voy\s+a|puedo|pienso)\s+(?:dar|compartir|pasar|dejar|enviar|mandar)(?:te|les|le)?\s+(?:mi\s+)?(?:n[uú]mero|celular|cel|tel[eé]fono|contacto)`,
    String.raw`no\s+(?:doy|comparto|paso)\s+(?:mi\s+)?(?:n[uú]mero|celular|cel|tel[eé]fono)`,
    String.raw`prefiero\s+(?:que\s+me\s+(?:escriban|respondan|atiendan|contesten|sigan\s+escribiendo)\s+|seguir\s+|hablar\s+|conversar\s+)?por\s+(?:aqu[ií]|ac[aá]|este\s+(?:medio|chat)|el\s+chat|chat|mensajes?|interno|dm|inbox|instagram|messenger|facebook)`,
    String.raw`(?:por\s+)?aqu[ií]\s+(?:nom[aá]s|no\s+m[aá]s|est[aá]\s+bien)`,
    String.raw`no\s+tengo\s+(?:celular|cel|tel[eé]fono|n[uú]mero)`,
    String.raw`sin\s+(?:dar\s+)?(?:mi\s+)?n[uú]mero`,
  ].join('|'),
  'iu',
)

const SAME_NUMBER_RE = new RegExp(
  [
    String.raw`(?:este|ese)\s+mismo`,
    String.raw`el\s+mismo`,
    String.raw`a\s+este\s+(?:n[uú]mero|celular|cel|chat)`,
    String.raw`(?:el|mi)\s+(?:n[uú]mero\s+)?(?:de(?:l)?\s+)?(?:whats?app|wsp|wasap|wpp|whatsap)`,
    String.raw`ya\s+(?:te|les|se)\s+(?:lo|la)\s+(?:di|dije|pas[eé]|envi[eé]|mand[eé]|escrib[ií])`,
    String.raw`ya\s+lo\s+(?:di|dije|envi[eé]|mand[eé]|pas[eé]|escrib[ií])`,
    String.raw`el\s+que\s+(?:sale|aparece|ves|tienes)`,
    String.raw`este\s+n[uú]mero`,
    String.raw`desde\s+el\s+que\s+(?:te\s+)?escribo`,
  ].join('|'),
  'iu',
)

const QUESTION_START_RE =
  /^(?:¿|cu[aá]nto|cu[aá]nta|d[oó]nde|c[oó]mo|qu[eé]|cu[aá]l(?:es)?|cu[aá]ndo|hacen|tienen|tiene|venden|env[ií]an|hay|aceptan|atienden|trabajan|puedo|pueden|podr[ií]an|me\s+pueden|me\s+puede|quisiera\s+saber|quiero\s+saber|info(?:rmaci[oó]n)?\s+(?:de|sobre)|precio|costo)(?![\p{L}])/iu

const ACK_WORDS = new Set([
  'gracias', 'gracia', 'muchas', 'mil', 'ok', 'okey', 'okay', 'oki', 'okis', 'vale', 'listo', 'ya', 'bueno', 'buenos',
  'dale', 'perfecto', 'entendido', 'genial', 'si', 'sí', 'claro', 'de', 'acuerdo', 'thanks', 'bien', 'super', 'súper',
  'excelente', 'jaja', 'jajaja', 'ah', 'aja', 'ajá', 'mmm', 'uhm',
])

function isAckOnly(text: string): boolean {
  const words = text
    .toLowerCase()
    .replace(/[\p{Extended_Pictographic}\p{P}\p{S}\d]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean)
  return words.every((w) => ACK_WORDS.has(w))
}

function isQuestion(text: string): boolean {
  return /[?¿]/.test(text) || text.split(/\n+/).some((l) => QUESTION_START_RE.test(l.trim()))
}

/** Pure: what this burst means for the held handoff. */
export function classifyHeldReply(items: HeldBurstItem[]): HeldReply {
  // Unreadable burst: a plain (counted) re-ask, as before.
  if (items.length === 0) return { kind: 'other' }
  const texts = items.map((i) => i.text?.trim() ?? '').filter(Boolean)
  if (texts.length > 0) {
    const joined = texts.join('\n')
    const typed = classifyTypedPhone(joined)
    if (typed.kind === 'phone') return { kind: 'phone', phone: typed.phone }
    if (typed.kind !== 'none') return { kind: typed.kind }
    if (INSULT_RE.test(joined)) return { kind: 'insult' }
    if (REFUSAL_RE.test(joined)) return { kind: 'refusal' }
    if (SAME_NUMBER_RE.test(joined)) return { kind: 'same_number' }
    if (isQuestion(joined)) return { kind: 'question' }
    if (isAckOnly(joined)) return { kind: 'ack' }
    return { kind: 'other' }
  }
  if (items.some((i) => i.type === 'image' || i.type === 'media')) return { kind: 'media' }
  if (items.some((i) => i.type === 'audio')) return { kind: 'audio' }
  // Stickers / reactions only.
  return { kind: 'ack' }
}

export type HeldAction =
  /** The number came in text but couldn't be linked (e.g. it belongs to
   *  another WhatsApp contact): hand off with it in the note. */
  | { action: 'handoff_with_phone'; phone: string }
  /** Hand off now without the number (refusal / insult / hard cap). */
  | { action: 'handoff_no_phone'; text: string; note: string; complaint?: boolean }
  /** Re-ask; counts toward MAX_PHONE_ASKS. */
  | { action: 'ask_counted'; text: string }
  /** Re-ask (or stay quiet when `text` is null); doesn't count. */
  | { action: 'ask_free'; text: string | null }
  /** Let the AI answer, then add ASK_PHONE_TEXT in one line. */
  | { action: 'answer_then_ask' }

const FREE_TEXT: Partial<Record<HeldReply['kind'], string>> = {
  incomplete: PHONE_INCOMPLETE_TEXT,
  multiple: PHONE_MULTIPLE_TEXT,
  foreign_no_plus: PHONE_FOREIGN_TEXT,
  landline: PHONE_LANDLINE_TEXT,
  media: PHONE_MEDIA_TEXT,
  audio: PHONE_AUDIO_TEXT,
}

/**
 * Pure: the bot's move for this turn. `turns` = bot turns already spent
 * waiting; `lastBusinessText` = the last thing the bot sent (to avoid
 * repeating itself and to stay quiet on an "ok" right after an ask).
 */
export function decideHeldAction(
  reply: HeldReply,
  ctx: { turns: number; lastBusinessText: string | null },
): HeldAction {
  if (reply.kind === 'phone') return { action: 'handoff_with_phone', phone: reply.phone }
  if (reply.kind === 'refusal') {
    return { action: 'handoff_no_phone', text: PHONE_REFUSED_TEXT, note: '🙅 El cliente prefirió no dar su número: atiéndelo por este chat.' }
  }
  if (reply.kind === 'insult') {
    return {
      action: 'handoff_no_phone',
      text: PHONE_UPSET_TEXT,
      note: '⚠️ El cliente está molesto y no dio su número: atiéndelo por este chat.',
      complaint: true,
    }
  }
  if (ctx.turns >= MAX_HELD_TURNS) {
    return { action: 'handoff_no_phone', text: '', note: '📵 El cliente no dio su número tras varios intentos.' }
  }
  const last = ctx.lastBusinessText?.trim() ?? null
  if (reply.kind === 'ack') {
    const askedAlready = last !== null && PHONE_ASK_TEXTS.some((t) => last.includes(t))
    return { action: 'ask_free', text: askedAlready ? null : ASK_PHONE_TEXT }
  }
  if (reply.kind === 'question') return { action: 'answer_then_ask' }
  const free = FREE_TEXT[reply.kind]
  if (free) {
    // The same correction twice in a row is no progress: it counts.
    return last === free ? { action: 'ask_counted', text: free } : { action: 'ask_free', text: free }
  }
  if (reply.kind === 'same_number') return { action: 'ask_counted', text: PHONE_SAME_NUMBER_TEXT }
  return { action: 'ask_counted', text: ASK_PHONE_TEXT }
}

/** Append the ask to an AI answer, in one line, never twice. */
export function withPhoneAsk(answer: string): string {
  const text = answer.trim()
  if (!text) return ASK_PHONE_TEXT
  if (PHONE_ASK_TEXTS.some((t) => text.includes(t))) return text
  return `${text}\n\n${ASK_PHONE_TEXT}`
}
