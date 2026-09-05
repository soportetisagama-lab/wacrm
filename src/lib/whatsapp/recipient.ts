import { sanitizePhoneForMeta } from './phone-utils'

/**
 * A resolved WhatsApp send target. Every outbound-send call site
 * (agent replies, flow/automation sends, reactions) should go through
 * `resolveRecipient` instead of reading `contact.phone` directly, so
 * BSUID-only contacts (migration 042 — usernames without a known
 * phone number) get a single, consistent fallback instead of each
 * call site growing its own copy of the same branch.
 */
export type RecipientIdentifier =
  | { kind: 'phone'; value: string }
  | { kind: 'bsuid'; value: string }

/** The subset of a contact row this needs. */
export interface RecipientContact {
  phone: string | null
  whatsapp_user_id?: string | null
}

/**
 * Resolve which identifier to send a WhatsApp API request to.
 *
 * Phone wins when present — mirrors Meta's own precedence (confirmed
 * against Meta's docs: `to` takes precedence over `recipient` when
 * both are present), and keeps existing phone-based contacts behaving
 * exactly as before this ever gets called from a real BSUID-aware
 * code path.
 *
 * Falls back to the contact's BSUID when there's no phone on file.
 * Unlike a phone number, a BSUID is not run through
 * `sanitizePhoneForMeta` — it isn't a phone number and has its own
 * format (e.g. "US.13491208655302741918"); digit-stripping it would
 * corrupt it.
 *
 * Returns null when the contact has neither. That shouldn't happen in
 * practice (every contact is created from one or the other — see
 * `findOrCreateContact` in the webhook), but callers must handle it
 * explicitly rather than falling through to sending an empty string.
 */
export function resolveRecipient(
  contact: RecipientContact,
): RecipientIdentifier | null {
  if (contact.phone) {
    const sanitized = sanitizePhoneForMeta(contact.phone)
    if (sanitized) return { kind: 'phone', value: sanitized }
  }
  if (contact.whatsapp_user_id) {
    return { kind: 'bsuid', value: contact.whatsapp_user_id }
  }
  return null
}

/**
 * Convert a resolved identifier into the exact request-body fields a
 * meta-api.ts send function expects (its `RecipientTarget`): `to` for
 * phone, `recipient` for BSUID — never both. Confirmed against Meta's
 * docs (business-scoped-user-ids, "Messages" section): `to` and
 * `recipient` are mutually exclusive, with `to` winning if both are
 * set, so a BSUID send must omit `to` entirely rather than send both.
 *
 * Spread this directly into a send call's args:
 *   sendTextMessage({ ...toRecipientTarget(recipient), phoneNumberId, accessToken, text })
 */
export function toRecipientTarget(
  recipient: RecipientIdentifier,
): { to: string } | { recipient: string } {
  return recipient.kind === 'phone'
    ? { to: recipient.value }
    : { recipient: recipient.value }
}
