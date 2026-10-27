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

/** True for a WhatsApp contact with no phone on file. Instagram/Messenger
 *  contacts never have one and keep their own handoff. Fails toward the
 *  normal handoff (false). */
export async function contactNeedsPhone(db: SupabaseClient, contactId: string): Promise<boolean> {
  try {
    const { data, error } = await db.from('contacts').select('*').eq('id', contactId).maybeSingle()
    if (error || !data) return false
    const row = data as { phone?: string | null; channel?: string | null }
    if (row.channel && row.channel !== 'whatsapp') return false
    return !(row.phone ?? '').trim()
  } catch {
    return false
  }
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
  if (!(await lastBusinessMessageIs(db, args.conversationId, PHONE_REQUEST_LOG_TEXT))) {
    try {
      await engineSendText({
        accountId: args.accountId,
        userId: args.userId,
        conversationId: args.conversationId,
        contactId: args.contactId,
        text: ASK_PHONE_TEXT,
      })
    } catch (err) {
      console.error('[ai awaiting phone] ask send failed:', err)
    }
  }
  return 'asked'
}
