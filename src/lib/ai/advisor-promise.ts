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

// Building blocks. JS `\b` and `\w` are ASCII-only, so word edges use
// letter classes (`\p{L}`): "asesoría" is not "asesor", "pondrá" is a verb.
const START = String.raw`(?<![\p{L}])`
const END = String.raw`(?![\p{L}])`

const SUBJECT =
  String.raw`(?:asesor(?:a|es|as)?|ejecutiv[oa]s?|vendedor(?:a|es|as)?|especialistas?|` +
  String.raw`(?:alguien|una\s+persona|un\s+miembro|uno|una)\s+de(?:l|\s+nuestro)?\s+equipo|` +
  String.raw`(?:el|nuestro)\s+equipo(?:\s+de\s+\p{L}+)?)${END}`

/** Optional article before the subject. */
const ART = String.raw`(?:(?:un|una|el|la|los|las|nuestr[oa]s?)\s+)?`

/** Words allowed between the subject and the verb ("un asesor DEL EQUIPO te…",
 *  "un asesor EN BREVE te…"). A closed list, so "un asesor PUEDE ayudarte"
 *  or "el asesor QUE te atendió" never match. */
const FILLER = String.raw`(?:del|de|nuestro|equipo|ventas|comercial|ya|pronto|en|breve|hoy|mañana|luego|enseguida|seguro|más|tarde|unos|minutos|momento|un|los|próximos|días|horas|personalmente|también|especializad[oa]s?|técnic[oa]s?|asignad[oa]s?)`
const FILLERS = String.raw`(?:\s+${FILLER}){0,4}`

/** When / how, for the present tense: "te llama EN BREVE", "te escribimos PRONTO". */
const SOON =
  String.raw`(?:pronto|en\s+breve|hoy|mañana|luego|enseguida|más\s+tarde|en\s+un\s+momento|en\s+unos\s+minutos|por\s+(?:aquí|teléfono|interno|privado|whatsapp|este\s+medio))${END}`
/** A present-tense contact verb only counts with SOON or at the end of the
 *  sentence — "le llaman acero 304" (naming) does not. */
const PRESENT_TAIL = String.raw`(?=\s+${SOON}|[^\S\n]*[.!,]*[^\S\n]*\p{Extended_Pictographic}*[^\S\n]*$)`

const QUOTE = String.raw`(?:tu|la|su|una)\s+(?:cotizaci[oó]n|proforma|presupuesto)${END}`
const CASE = String.raw`(?:tu|su)\s+(?:caso|consulta|solicitud|pedido|cotizaci[oó]n)${END}`
/** Usted: "lo/la contactará / escribirá / llamará", future or "va a" only —
 *  the present "lo/la llama(n)" is naming ("lo llaman acero 304"). */
const USTED_VERB = String.raw`(?:lo|la)\s+(?:(?:va|van)\s+a\s+)?(?:contactar|escribir|llamar)\p{L}*`

/** "va a" / "van a" before an infinitive. */
const WILL = String.raw`(?:(?:va|van)\s+a\s+)?`

/** Contact verbs after `te`/`le` (usted "lo/la" goes through USTED_VERB). */
function contactVerb(withAttend: boolean): string {
  return (
    String.raw`(?:escrib\p{L}*|contact\p{L}*|respond\p{L}*|llamar\p{L}*|llaman?${PRESENT_TAIL}` +
    (withAttend ? String.raw`|atender\p{L}*|atienden?${PRESENT_TAIL}` : '') +
    String.raw`|(?:envi|mand)\p{L}*\s+${QUOTE})`
  )
}

/** A schedule ("de lunes a viernes de 9 a 6"): "te atenderá" there is an
 *  opening-hours statement, not a promise. */
const SCHEDULE_RE =
  /(?<![\p{L}])(?:lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bados?|domingos?|feriados?|horario)(?![\p{L}])|\d{1,2}(?::\d{2})?\s*(?:a|-|y|hasta)\s*\d{1,2}|\d\s*(?:am|pm|a\.\s?m|p\.\s?m|hrs?)(?![\p{L}])/iu

function promiseRes(withAttend: boolean): RegExp[] {
  const verb = contactVerb(withAttend)
  return [
    // Subject first: "un asesor (del equipo) te escribe / contactará / llamará…",
    // "un asesor preparará tu cotización", "se comunicará contigo".
    new RegExp(
      START +
        ART +
        SUBJECT +
        FILLERS +
        String.raw`\s+(?:(?:te|le)\s+${WILL}${verb}|${USTED_VERB}` +
        String.raw`|${WILL}(?:preparar\p{L}*|envi\p{L}*|mand\p{L}*|har[aá]n?|hacer)\s+${QUOTE}` +
        String.raw`|se\s+${WILL}(?:comunic\p{L}*|pondr\p{L}*\s+en\s+contacto|ponen?\s+en\s+contacto|contact\p{L}*)` +
        String.raw`|(?:va|van)\s+a\s+(?:tomar|continuar|seguir)\s+(?:con\s+)?${CASE}` +
        String.raw`|(?:tomar[aá]n?|continuar[aá]n?)\s+(?:con\s+)?${CASE})`,
      'iu',
    ),
    // Verb first: "(pronto) te contactará un asesor".
    new RegExp(
      START +
        String.raw`(?:te|le|lo|la)\s+${WILL}(?:contact\p{L}*|escribir\p{L}*|llamar\p{L}*|responder\p{L}*` +
        (withAttend ? String.raw`|atender\p{L}*` : '') +
        String.raw`)(?:\s+${FILLER}){0,3}\s+${ART}${SUBJECT}`,
      'iu',
    ),
    // Compound: "un asesor revisará tu caso y te contactará".
    new RegExp(
      START +
        ART +
        SUBJECT +
        String.raw`(?:\s+\p{L}+){1,4}\s+y\s+(?:te|le|lo|la)\s+${WILL}(?:contactar|escribir|llamar|responder)\p{L}*`,
      'iu',
    ),
    // No subject: "te van a contactar", "te estará contactando",
    // "le enviaremos la cotización".
    new RegExp(
      START +
        String.raw`(?:te|le|lo|la)\s+(?:van\s+a\s+(?:contactar|llamar|escribir)|estar[aá]n?\s+(?:contactando|llamando|escribiendo))${END}`,
      'iu',
    ),
    new RegExp(
      START +
        String.raw`(?:te|le)\s+(?:enviaremos|mandaremos|vamos\s+a\s+(?:enviar|mandar))\s+${QUOTE}`,
      'iu',
    ),
    // Handover: "te derivo / te paso / te comunicamos con un asesor",
    // "derivaré tu consulta a un asesor", "le pasaremos tu consulta a un asesor".
    new RegExp(
      START +
        String.raw`(?:(?:te|le)\s+)?(?:ya\s+)?` +
        String.raw`(?:deriv\p{L}*|pas(?:o|é|e|ar[eé]|aremos|amos|ar[ií]a)|comunic(?:o|amos|ar[eé]|aremos)|transfi?er\p{L}*|conect\p{L}*|(?:voy|vamos)\s+a\s+(?:derivar|pasar|comunicar|transferir|conectar))` +
        String.raw`\s+(?:${CASE}\s+)?(?:con|a)\s+${ART}${SUBJECT}`,
      'iu',
    ),
    // We-forms: "te contactamos", "te llamaremos", "te escribimos pronto",
    // "te responderemos pronto".
    new RegExp(
      START +
        String.raw`(?:te|le)\s+(?:contactamos|contactaremos|llamaremos|escribiremos|responderemos|vamos\s+a\s+(?:contactar|llamar|escribir|responder)` +
        String.raw`|(?:escribimos|llamamos|respondemos)${PRESENT_TAIL})${END}`,
      'iu',
    ),
    new RegExp(
      START +
        String.raw`nos\s+(?:comunicaremos|pondremos\s+en\s+contacto|contactaremos|vamos\s+a\s+(?:comunicar|poner\s+en\s+contacto))${END}`,
      'iu',
    ),
  ]
}

const PROMISE_RES = promiseRes(true)
const PROMISE_RES_SCHEDULE = promiseRes(false)

/** Pure: true when this one sentence promises an advisor / a callback. */
export function sentencePromisesAdvisor(sentence: string): boolean {
  const s = sentence.trim()
  if (!s) return false
  // A question offers, it doesn't promise.
  if (/\?\s*\p{Extended_Pictographic}*\s*$/u.test(s) || s.startsWith('¿')) return false
  const res = SCHEDULE_RE.test(s) ? PROMISE_RES_SCHEDULE : PROMISE_RES
  return res.some((re) => re.test(s))
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
