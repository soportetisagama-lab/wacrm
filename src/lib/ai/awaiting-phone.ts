import type { SupabaseClient } from '@supabase/supabase-js'
import { engineSendText } from '@/lib/flows/meta-send'
import { lastBusinessMessageIs } from './debounce'

// ============================================================
// Handoff on hold until a phone-less WhatsApp contact (BSUID only)
// shares their number. Telling that customer "un asesor te escribe por
// aquí" promises a callback nobody can make, so every handoff exit (the
// general assistant's and the Flows') asks for the number instead and
// keeps the bot on the thread; the webhook completes the handoff
// (closing line + advisor brief) as soon as the number arrives — shared
// button or typed (promoteBsuidContactPhoneIfRequested).
//
// The pending state lives in `conversations.ai_handoff_summary` (no new
// column): a marker line with the ask count, an optional settings line
// (a flow's own closing text / assignee), then the note the advisor gets
// once the handoff goes through. The inbox only shows that column while
// the bot is paused; a held handoff keeps it running, and a manual pause
// strips the marker (api/ai/autoreply).
//
// Concurrency: only whoever swaps the exact marker it read (conditional
// update, see swapHeldMarker) acts on a held handoff — the webhook (number
// arrived) and the assistant (next message) can never both close it.
// ============================================================

/** What the customer reads — also the body of the webhook's
 *  REQUEST_CONTACT_INFO button, so a turn that already sent the button
 *  needs nothing else. */
export const ASK_PHONE_TEXT = 'Para ayudarte mejor, ¿nos compartes tu número de celular?'

/** `content_text` the webhook logs for its REQUEST_CONTACT_INFO send. */
export const PHONE_REQUEST_LOG_TEXT = 'Se solicitó el número de contacto'

/** After this many asks without a number the handoff goes through anyway,
 *  with NO_PHONE_GIVE_UP_TEXT (no "te escribe por aquí"). */
export const MAX_PHONE_ASKS = 3

export const NO_PHONE_GIVE_UP_TEXT = 'Gracias. Ya dejé tu consulta con un asesor del equipo para que la revise.'

/** What a flow handoff wants once the number arrives, instead of the
 *  assistant's default closing line / handoff agent. */
export interface HeldHandoffOptions {
  /** Closing text in business hours (a handoff node's customer_message). */
  closing?: string
  /** Closing text after hours (may hold business-hours placeholders). */
  closingAfterHours?: string
  /** Advisor to assign (a handoff node's assign_to). */
  assignTo?: string
  /** Every bot turn spent waiting (questions and attempts included) —
   *  the hard cap of lib/ai/phone-ask.ts (MAX_HELD_TURNS). */
  turns?: number
}

export interface HeldHandoff {
  asks: number
  summary: string
  options: HeldHandoffOptions
}

const AWAITING_PREFIX = '📵 Derivación esperando el celular del cliente'
const AWAITING_RE = /^📵 Derivación esperando el celular del cliente \((\d+)\/\d+\)\n?([\s\S]*)$/u
const OPTIONS_PREFIX = '⚙ '

function cleanOptions(o: HeldHandoffOptions | undefined): HeldHandoffOptions {
  const out: HeldHandoffOptions = {}
  if (o?.closing?.trim()) out.closing = o.closing.trim()
  if (o?.closingAfterHours?.trim()) out.closingAfterHours = o.closingAfterHours.trim()
  if (o?.assignTo) out.assignTo = o.assignTo
  if (typeof o?.turns === 'number' && Number.isFinite(o.turns) && o.turns > 0) out.turns = Math.floor(o.turns)
  return out
}

/** Pure: the `ai_handoff_summary` value for a handoff on hold. */
export function awaitingPhoneSummary(
  asks: number,
  summary: string,
  options?: HeldHandoffOptions,
): string {
  const opts = cleanOptions(options)
  const optsLine = Object.keys(opts).length > 0 ? `${OPTIONS_PREFIX}${JSON.stringify(opts)}\n` : ''
  return `${AWAITING_PREFIX} (${asks}/${MAX_PHONE_ASKS})\n${optsLine}${summary}`
}

/** Pure: the held handoff in `ai_handoff_summary`, or null when there is none. */
export function parseAwaitingPhone(summary: string | null | undefined): HeldHandoff | null {
  const m = summary ? AWAITING_RE.exec(summary) : null
  if (!m) return null
  let rest = m[2]
  let options: HeldHandoffOptions = {}
  if (rest.startsWith(OPTIONS_PREFIX)) {
    const nl = rest.indexOf('\n')
    const line = nl === -1 ? rest : rest.slice(0, nl)
    try {
      options = cleanOptions(JSON.parse(line.slice(OPTIONS_PREFIX.length)) as HeldHandoffOptions)
      rest = nl === -1 ? '' : rest.slice(nl + 1)
    } catch {
      options = {}
    }
  }
  return { asks: Number(m[1]), summary: rest, options }
}

/** Instagram / Messenger give-up line: those chats are served first by
 *  the Community Manager, so no advisor is promised either. */
export const SOCIAL_NO_PHONE_GIVE_UP_TEXT = 'Gracias. Ya registramos tu consulta y el equipo la revisará.'

/** Instagram / Messenger closing line once the number is on file —
 *  never "un asesor te escribe por aquí". */
export const SOCIAL_HANDOFF_CLOSING_TEXT = '¡Gracias! Ya registramos tu número y te contactamos pronto.'

export interface ContactPhoneState {
  /** Instagram / Messenger (anything but WhatsApp). */
  social: boolean
  /** The handoff must wait for the number. */
  needsPhone: boolean
  /** Instagram / Messenger: the number the customer typed (migration 086). */
  socialPhone: string | null
}

/**
 * Pure: phone state of a contact row.
 * - WhatsApp: needs a phone when `phone` is empty (BSUID-only contact).
 * - Instagram / Messenger: `phone` stays NULL on purpose (migration 081 —
 *   a phone there would make findExistingContact() merge the person's
 *   WhatsApp chats into the social one); the typed number lives in
 *   `contact_phone` (migration 086). Before 086 runs the column doesn't
 *   exist and the handoff goes through as before (fail toward handoff).
 */
export function phoneStateOf(row: { phone?: string | null; channel?: string | null; contact_phone?: string | null }): ContactPhoneState {
  const social = Boolean(row.channel && row.channel !== 'whatsapp')
  if (social) {
    const socialPhone = (row.contact_phone ?? '').trim() || null
    return { social, needsPhone: 'contact_phone' in row && !socialPhone, socialPhone }
  }
  return { social, needsPhone: !(row.phone ?? '').trim(), socialPhone: null }
}

/** Phone state of a contact, or null when it can't be read. */
export async function loadContactPhoneState(
  db: SupabaseClient,
  contactId: string,
): Promise<ContactPhoneState | null> {
  try {
    const { data, error } = await db.from('contacts').select('*').eq('id', contactId).maybeSingle()
    if (error || !data) return null
    return phoneStateOf(data as { phone?: string | null; channel?: string | null; contact_phone?: string | null })
  } catch {
    return null
  }
}

/** True for a contact whose handoff must wait for their number: a
 *  WhatsApp contact with no phone, or an Instagram/Messenger contact that
 *  hasn't typed one yet. Fails toward the normal handoff (false). */
export async function contactNeedsPhone(db: SupabaseClient, contactId: string): Promise<boolean> {
  return (await loadContactPhoneState(db, contactId))?.needsPhone ?? false
}

/** The give-up line for this contact's channel. */
export function noPhoneGiveUpTextFor(state: Pick<ContactPhoneState, 'social'> | null): string {
  return state?.social ? SOCIAL_NO_PHONE_GIVE_UP_TEXT : NO_PHONE_GIVE_UP_TEXT
}

/** Instagram / Messenger closing line: the number on file, or the give-up
 *  line when there is none (no promise either way). */
export function socialClosingTextFor(state: Pick<ContactPhoneState, 'socialPhone'>): string {
  return state.socialPhone ? SOCIAL_HANDOFF_CLOSING_TEXT : SOCIAL_NO_PHONE_GIVE_UP_TEXT
}

/** Line added to the advisor note so the Community Manager sees the
 *  number (social contacts have no `phone`). */
export function socialPhoneNote(state: Pick<ContactPhoneState, 'socialPhone'> | null): string {
  return state?.socialPhone ? `📱 Celular del cliente: +${state.socialPhone.replace(/^\+/, '')}` : ''
}

/** The conversation's current `ai_handoff_summary` (null on any failure). */
export async function loadHandoffSummary(
  db: SupabaseClient,
  conversationId: string,
): Promise<string | null> {
  try {
    const { data } = await db
      .from('conversations')
      .select('ai_handoff_summary')
      .eq('id', conversationId)
      .maybeSingle()
    return (data?.ai_handoff_summary as string | null | undefined) ?? null
  } catch {
    return null
  }
}

/** True when the conversation has a handoff on hold for the number. */
export async function isAwaitingPhoneHandoff(
  db: SupabaseClient,
  conversationId: string,
): Promise<boolean> {
  return parseAwaitingPhone(await loadHandoffSummary(db, conversationId)) !== null
}

/**
 * Atomically replace the exact held marker `expected` with `next` (plus
 * any `extra` columns). True only for the caller whose UPDATE matched —
 * a concurrent actor that already changed the marker makes it false, and
 * that caller must then do nothing (no closing, no brief, no reply).
 */
export async function swapHeldMarker(
  db: SupabaseClient,
  conversationId: string,
  expected: string,
  next: string,
  extra: Record<string, unknown> = {},
): Promise<boolean> {
  try {
    const { data, error } = await db
      .from('conversations')
      .update({ ...extra, ai_handoff_summary: next })
      .eq('id', conversationId)
      .eq('ai_handoff_summary', expected)
      .select('id')
    if (error) {
      console.error('[ai awaiting phone] marker swap failed:', error.message)
      return false
    }
    return Array.isArray(data) && data.length > 0
  } catch (err) {
    console.error('[ai awaiting phone] marker swap failed:', err)
    return false
  }
}

/**
 * Put a handoff on hold (or keep it on hold): bump the marker, then ask
 * for the number — unless the webhook's button is already the last thing
 * we sent (one ask per turn). Outcomes:
 *   - 'asked': on hold, bot stays active.
 *   - 'give_up': MAX_PHONE_ASKS asks went unanswered; the marker is
 *     already cleared (back to the plain note) — the caller hands off for
 *     real with NO_PHONE_GIVE_UP_TEXT.
 *   - 'lost': someone else changed the held marker meanwhile — do nothing.
 */
export async function askPhoneBeforeHandoff(
  db: SupabaseClient,
  args: {
    accountId: string
    conversationId: string
    contactId: string
    userId: string
    summary: string
    options?: HeldHandoffOptions
    /** What to say instead of ASK_PHONE_TEXT (lib/ai/phone-ask.ts). */
    text?: string
  },
): Promise<'asked' | 'give_up' | 'lost'> {
  const current = await loadHandoffSummary(db, args.conversationId)
  const held = parseAwaitingPhone(current)
  if (held && current) {
    if (held.asks >= MAX_PHONE_ASKS) {
      return (await swapHeldMarker(db, args.conversationId, current, args.summary))
        ? 'give_up'
        : 'lost'
    }
    const next = awaitingPhoneSummary(held.asks + 1, args.summary, args.options)
    if (!(await swapHeldMarker(db, args.conversationId, current, next, { ai_autoreply_disabled: false }))) {
      return 'lost'
    }
  } else {
    await db
      .from('conversations')
      .update({
        ai_autoreply_disabled: false,
        ai_handoff_summary: awaitingPhoneSummary(1, args.summary, args.options),
      })
      .eq('id', args.conversationId)
  }
  const text = args.text ?? ASK_PHONE_TEXT
  if (!(await lastBusinessMessageIs(db, args.conversationId, PHONE_REQUEST_LOG_TEXT))) {
    try {
      await engineSendText({
        accountId: args.accountId,
        userId: args.userId,
        conversationId: args.conversationId,
        contactId: args.contactId,
        text,
      })
    } catch (err) {
      console.error('[ai awaiting phone] ask send failed:', err)
    }
  }
  return 'asked'
}
