// ============================================================
// Deterministic guards for everything the AI learns (memory, learned
// examples, self-review). Two hard rules from management:
//   1. Never prices: no amounts, currencies, quotes or discounts.
//   2. No personal data: phones, emails, DNI, RUC, street addresses.
// Pure functions, no I/O — the same checks run before the model sees a
// transcript (`redactSensitive`) and on whatever it returns
// (`checkLearnable`), so a model slip can never reach the database.
// ============================================================

export type GuardReason = 'price' | 'phone' | 'email' | 'dni' | 'ruc' | 'address'

export interface GuardResult {
  ok: boolean
  reasons: GuardReason[]
}

// --- Prices -------------------------------------------------

/** Words that only show up when talking money. */
const PRICE_WORDS: RegExp[] = [
  /\bprecios?\b/i,
  /\bcuest(?:a|an|en|e)\b/i,
  /\bcost(?:os|o|ar|aría|aria|ará|ara|aron|ó)(?![a-záéíóúñ])/i,
  /\bcotiz/i,
  /\bdescuentos?\b/i,
  /\bdscto/i,
  /\brebajas?\b/i,
  /\bsoles\b/i,
  /\blucas\b/i,
  /\bd[oó]lar(?:es)?\b/i,
  /\busd\b/i,
  /\bpresupuesto\b/i,
  /\btarifas?\b/i,
]

/** Currency symbols. `S/` but not the address shorthand `s/n`. */
const CURRENCY_SYMBOL = /(?:\bs\/\.?(?!n\b)|us\$|\$|€)/i

/** Any percentage (discounts, margins). */
const PERCENT = /%|\bpor\s*ciento\b/i

/** Amount tied to a currency, either order: "S/ 1,200", "1500 soles", "200 lucas". */
const AMOUNT_RE =
  /(?:(?:\bs\/\.?(?!n\b)|us\$|\$|€|\busd\b|\bpen\b)\s*\d[\d.,]*(?:\s*(?:mil|k)\b)?|\b\d[\d.,]*\s*(?:mil\s+)?(?:soles|sol|lucas|d[oó]lares|usd|pen)\b|\b\d[\d.,]*\s*%|\b\d[\d.,]*\s*por\s*ciento\b)/gi

export function hasPrice(text: string): boolean {
  if (!text) return false
  if (CURRENCY_SYMBOL.test(text) || PERCENT.test(text)) return true
  AMOUNT_RE.lastIndex = 0
  if (AMOUNT_RE.test(text)) return true
  return PRICE_WORDS.some((re) => re.test(text))
}

// --- Personal data -------------------------------------------

const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi
/** RUC: 11 digits starting 10/15/17/20. */
const RUC_RE = /\b(?:10|15|17|20)\d{9}\b/g
/** DNI: exactly 8 digits on their own. */
const DNI_RE = /\b\d{8}\b/g
/** Phones: Peruvian mobiles (9xx xxx xxx, optional +51), landlines
 *  with area code (01 234 5678) and any unbroken run of 7+ digits
 *  (dashes/dots allowed). Spaced number lists like measurements
 *  ("150 200 300") are not phones. */
const PHONE_RE =
  /(?:\+?51[\s.-]?)?\b9\d{2}[\s.-]?\d{3}[\s.-]?\d{3}\b|\(?\b0\d{1,2}\)?[\s-]?\d{3}[\s-]?\d{4}\b|\+\d{1,3}[\s.-]?\d(?:[\s.-]?\d){6,}\b|\b\d(?:[.-]?\d){6,}\b/g
/** Street-address markers (Peru). */
const ADDRESS_RE =
  /\b(?:av\.|avenida|jr\.|jir[oó]n|calle|psje\.?|pasaje|mz\.?|manzana|lote|lt\.|urb\.|urbanizaci[oó]n|direcci[oó]n|domicilio|n[°º]\s*\d|nro\.?\s*\d)(?:[^\n,.;]{0,40})/gi

function countDigits(s: string): number {
  return (s.match(/\d/g) ?? []).length
}

function test(re: RegExp, text: string): boolean {
  re.lastIndex = 0
  const r = re.test(text)
  re.lastIndex = 0
  return r
}

export function findPersonalData(text: string): GuardReason[] {
  if (!text) return []
  const out = new Set<GuardReason>()
  if (test(EMAIL_RE, text)) out.add('email')
  if (test(RUC_RE, text)) out.add('ruc')
  if (test(DNI_RE, text)) out.add('dni')
  PHONE_RE.lastIndex = 0
  for (const m of text.matchAll(PHONE_RE)) {
    const digits = countDigits(m[0])
    // 8 = DNI and 11 = RUC are reported as such above, not as phones.
    if (digits >= 7 && !(digits === 8 && /^\d{8}$/.test(m[0].trim())) && !(digits === 11 && test(RUC_RE, m[0]))) {
      out.add('phone')
      break
    }
  }
  if (test(ADDRESS_RE, text)) out.add('address')
  return [...out]
}

export function hasPersonalData(text: string): boolean {
  return findPersonalData(text).length > 0
}

// --- Combined ------------------------------------------------

/** True only when the text has no price and no personal data. */
export function checkLearnable(text: string): GuardResult {
  const reasons: GuardReason[] = []
  if (hasPrice(text)) reasons.push('price')
  reasons.push(...findPersonalData(text))
  return { ok: reasons.length === 0, reasons }
}

/**
 * Mask amounts and personal data in a transcript BEFORE sending it to
 * the model, so it never sees them. Price words ("precio", "cotizar")
 * stay — they're context, not data — and the output guard drops them.
 */
export function redactSensitive(text: string): string {
  if (!text) return text
  return text
    .replace(EMAIL_RE, '[correo]')
    .replace(RUC_RE, '[documento]')
    .replace(AMOUNT_RE, '[monto]')
    .replace(PHONE_RE, (m) => (countDigits(m) >= 7 ? (countDigits(m) === 8 ? '[documento]' : '[teléfono]') : m))
    .replace(DNI_RE, '[documento]')
    .replace(ADDRESS_RE, '[dirección]')
    .replace(/(?:\bs\/\.?(?!n\b)|us\$|\$|€)/gi, '[monto]')
}
