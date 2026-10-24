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

/** Units that make a figure a measurement / quantity / time, not money. */
const UNIT_SRC = String.raw`(?:mm|cm|m2|m²|m3|m³|mts?|metros?|m|kg|kgs|kilos?|gr?|gramos|l|lts?|litros?|ml|galones|gal|unidades|unid|und|uds|u|piezas|pzas?|pulg(?:adas)?|"|x|w|watts?|v|voltios|hp|°c?|grados|cuadras?|pisos?|personas|puestos|platos|quemadores|pozas|bandejas|niveles|puertas|d[ií]as|semanas|horas|hrs?|h|minutos|min|meses|a[nñ]os|am|pm)`
const AFTER_UNIT = String.raw`(?![a-záéíóúñ0-9])`
const NOT_A_MEASURE = String.raw`(?!\d)(?![.,]\d)(?!\s*${UNIT_SRC}${AFTER_UNIT})`

/**
 * Amount WITHOUT currency, in a price context: "en 1200", "a 350",
 * "me lo dejas en 800", "sale 450", "por 1,500". Group 1 keeps the lead
 * words so redaction only masks the figure. Measurements, quantities
 * and times ("a 30 minutos", "en 120 cm") don't count.
 */
const CONTEXT_AMOUNT_RE = new RegExp(
  String.raw`(\b(?:precios?|cuesta|cuestan|costo|sale|salen|vale|valen|cobr[a-záéíóú]*|pag[a-záéíóú]*|dej[a-záéíóú]*|qued[a-záéíóú]*|total|monto|en|a|por)\s+(?:(?:de|unos|unas|como|solo|sólo|apenas|los|las|el|la)\s+)?)` +
    String.raw`(\d[\d.,]*\d)${NOT_A_MEASURE}`,
  'gi',
)

function testRe(re: RegExp, text: string): boolean {
  re.lastIndex = 0
  const r = re.test(text)
  re.lastIndex = 0
  return r
}

export function hasPrice(text: string): boolean {
  if (!text) return false
  if (CURRENCY_SYMBOL.test(text) || PERCENT.test(text)) return true
  if (testRe(AMOUNT_RE, text) || testRe(CONTEXT_AMOUNT_RE, text)) return true
  return PRICE_WORDS.some((re) => re.test(text))
}

const FIGURE_RE = /\d[\d.,]*\d|\d/g
const UNIT_AFTER_RE = new RegExp(String.raw`^\s*${UNIT_SRC}${AFTER_UNIT}`, 'i')

/**
 * For stored memory: a figure of 3+ digits that is not a measurement
 * (followed by a unit, or the second side of "60 x 120"). Such a number
 * could be a price, a phone fragment or an order number — drop it.
 */
export function hasBareFigure(text: string): boolean {
  if (!text) return false
  for (const m of text.matchAll(FIGURE_RE)) {
    if ((m[0].match(/\d/g) ?? []).length < 3) continue
    const start = m.index ?? 0
    if (UNIT_AFTER_RE.test(text.slice(start + m[0].length))) continue
    if (/x\s*$/i.test(text.slice(0, start))) continue
    return true
  }
  return false
}

/**
 * Narrower than `hasPrice`: a concrete amount, currency symbol or
 * percentage, ignoring price *words*. For exam texts, which may say
 * "no da precios" but must never carry a figure.
 */
export function hasAmount(text: string): boolean {
  if (!text) return false
  if (CURRENCY_SYMBOL.test(text) || PERCENT.test(text)) return true
  return testRe(AMOUNT_RE, text) || testRe(CONTEXT_AMOUNT_RE, text)
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
    .replace(CONTEXT_AMOUNT_RE, '$1[monto]')
    .replace(PHONE_RE, (m) => (countDigits(m) >= 7 ? (countDigits(m) === 8 ? '[documento]' : '[teléfono]') : m))
    .replace(DNI_RE, '[documento]')
    .replace(ADDRESS_RE, '[dirección]')
    .replace(/(?:\bs\/\.?(?!n\b)|us\$|\$|€)/gi, '[monto]')
}
