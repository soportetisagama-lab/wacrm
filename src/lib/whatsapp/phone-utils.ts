/**
 * Sanitize phone number for Meta WhatsApp API.
 * Meta requires digits only — no + prefix, no spaces, no dashes.
 * e.g. "+370 63949836" → "37063949836"
 */
export function sanitizePhoneForMeta(phone: string): string {
  if (!phone) return ''
  return phone.replace(/\D/g, '')
}

/**
 * Normalize phone number by removing all non-digit characters.
 * Used for comparing phone numbers in different formats.
 */
export function normalizePhone(phone: string): string {
  if (!phone) return ''
  return phone.replace(/\D/g, '')
}

/**
 * Compare two phone numbers accounting for trunk prefix differences.
 * e.g. "370063949836" (with trunk 0) matches "37063949836" (without trunk 0)
 * by comparing the last 8 digits.
 */
export function phonesMatch(phone1: string, phone2: string): boolean {
  const n1 = normalizePhone(phone1)
  const n2 = normalizePhone(phone2)
  if (n1 === n2) return true
  if (n1.length >= 8 && n2.length >= 8) {
    return n1.slice(-8) === n2.slice(-8)
  }
  return false
}

/**
 * Validate phone number is E.164-like format (7-15 digits starting with non-zero).
 * Accepts with or without + prefix.
 */
export function isValidE164(phone: string): boolean {
  return /^\+?[1-9]\d{6,14}$/.test(phone)
}

/**
 * Generate plausible phone number variants for retry when Meta's
 * sandbox rejects a number with error #131030 ("not in allowed list").
 *
 * Many countries use a "trunk prefix" 0 for domestic dialing that is
 * meant to be dropped in international format (e.g. Lithuanian
 * "+370 063 949 836" domestically → "+370 63 949 836" international).
 * But some sandboxes register the number with the trunk 0 included,
 * causing sends to the correct international format to fail.
 *
 * This helper yields up to 3 variants:
 *   1. The original sanitized number (first attempt)
 *   2. With a trunk 0 inserted after the country code
 *   3. With a trunk 0 removed after the country code
 *
 * Country-code lengths of 1, 2, and 3 digits are tried because we
 * don't know the user's country ahead of time.
 *
 * @param sanitized - digits-only phone number (from sanitizePhoneForMeta)
 * @returns deduplicated list of variants, original first
 */
export function phoneVariants(sanitized: string): string[] {
  if (!sanitized) return []
  const seen = new Set<string>()
  const push = (v: string) => {
    if (v && !seen.has(v)) seen.add(v)
  }

  // 1. Original
  push(sanitized)

  // 2. Insert a 0 after each plausible country-code length
  for (const ccLen of [1, 2, 3]) {
    if (sanitized.length <= ccLen) continue
    const cc = sanitized.slice(0, ccLen)
    const rest = sanitized.slice(ccLen)
    if (!rest.startsWith('0')) {
      push(cc + '0' + rest)
    }
  }

  // 3. Remove a leading 0 after each plausible country-code length
  for (const ccLen of [1, 2, 3]) {
    if (sanitized.length <= ccLen + 1) continue
    const cc = sanitized.slice(0, ccLen)
    const rest = sanitized.slice(ccLen)
    if (rest.startsWith('0')) {
      push(cc + rest.slice(1))
    }
  }

  return [...seen]
}

/**
 * Returns true when the Meta API error indicates the recipient
 * phone number isn't in the allowed list (sandbox restriction).
 * Detected via error code 131030 or the standard error text.
 */
export function isRecipientNotAllowedError(message: string): boolean {
  return /131030|not in allowed list|not in the allowed list/i.test(message)
}

export type TypedPhoneResult =
  | { kind: 'phone'; phone: string }
  | { kind: 'incomplete' }
  | { kind: 'multiple' }
  | { kind: 'none' }

/**
 * Classify a customer's free-text reply to our REQUEST_CONTACT_INFO
 * ask — the case where a username/BSUID-only lead TYPES the number
 * ("974 710 551") instead of tapping the button, which Meta delivers
 * as a plain `text` message with no contact card.
 *
 * Deliberately conservative — a wrong number stamped onto a contact is
 * worse than asking again — so it only looks at a message that is
 * essentially just the number, optionally with a short lead-in like
 * "mi número es" (at most 30 letters of surrounding text):
 *   - 'phone'      exactly one number, and it's a Peruvian mobile
 *                  (9 digits starting with 9, with or without 51 /
 *                  +51) or an explicit "+" international number.
 *                  `phone` is digits-only, same shape as
 *                  normalizePhone(message.from), e.g. "51974710551".
 *   - 'incomplete' one number that looks like a Peruvian mobile
 *                  attempt (starts with 9) but has the wrong digit
 *                  count — "974 710 55".
 *   - 'multiple'   two or more mobile-looking numbers.
 *   - 'none'       anything else (normal chat, a DNI/RUC, a long
 *                  message that merely contains digits).
 * The caller uses 'incomplete' / 'multiple' only to word the re-ask
 * so the customer understands what went wrong.
 */
export function classifyTypedPhone(text: string): TypedPhoneResult {
  if (!text) return { kind: 'none' }
  const candidates = (text.match(/\+?\d[\d\s\-().]{4,}\d/g) ?? []).filter(
    (c) => normalizePhone(c).length >= 7
  )
  if (candidates.length === 0) return { kind: 'none' }

  let rest = text
  for (const c of candidates) rest = rest.replace(c, '')
  if ((rest.match(/\p{L}/gu) ?? []).length > 30) return { kind: 'none' }

  // National part of a Peruvian number: strip a leading 51 only when
  // what follows is a mobile (starts with 9).
  const national = (c: string) => {
    const digits = normalizePhone(c)
    return /^519/.test(digits) && digits.length > 9 ? digits.slice(2) : digits
  }
  const mobileLike = candidates.filter((c) => national(c).startsWith('9'))

  if (candidates.length > 1) {
    return mobileLike.length > 1 ? { kind: 'multiple' } : { kind: 'none' }
  }
  if (/\d/.test(rest)) return { kind: 'none' }

  const candidate = candidates[0]
  const digits = normalizePhone(candidate)
  if (/^9\d{8}$/.test(digits)) return { kind: 'phone', phone: `51${digits}` }
  if (/^519\d{8}$/.test(digits)) return { kind: 'phone', phone: digits }
  if (candidate.trim().startsWith('+') && digits.length >= 8 && isValidE164(`+${digits}`)) {
    // An explicit +51 that isn't a valid mobile is a mistyped Peruvian
    // number, not a foreign one.
    if (digits.startsWith('51')) return { kind: 'incomplete' }
    return { kind: 'phone', phone: digits }
  }
  if (mobileLike.length === 1) return { kind: 'incomplete' }
  return { kind: 'none' }
}

/** The phone from classifyTypedPhone, or null for every other outcome. */
export function extractTypedPhone(text: string): string | null {
  const result = classifyTypedPhone(text)
  return result.kind === 'phone' ? result.phone : null
}
