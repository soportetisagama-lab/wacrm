import type { SupabaseClient } from '@supabase/supabase-js'
import { engineSendText } from '@/lib/flows/meta-send'
import { lastBusinessMessageIs } from './debounce'

// ============================================================
// Handoff on hold until a phone-less WhatsApp contact (BSUID only)
// shares their number. Telling that customer "un asesor te escribe por
// aquí" promises a callback nobody can make, so every handoff exit asks
// for the number instead and keeps the bot on the thread; the webhook
// completes the handoff (closing line + advisor brief) as soon as the
// number arrives — shared button or typed (promoteBsuidContactPhoneIfRequested).
//
// The pending state lives in `conversations.ai_handoff_summary` (no new
// column): a marker line with the ask count, then the note the advisor
// gets once the handoff goes through. The inbox only shows that column
// while the bot is paused, and a held handoff keeps it running, so the
// marker never reaches the advisor's banner.
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

const AWAITING_PREFIX = '📵 Derivación esperando el celular del cliente'
const AWAITING_RE = /^📵 Derivación esperando el celular del cliente \((\d+)\/\d+\)\n?([\s\S]*)$/u

/** Pure: the `ai_handoff_summary` value for a handoff on hold. */
export function awaitingPhoneSummary(asks: number, summary: string): string {
  return `${AWAITING_PREFIX} (${asks}/${MAX_PHONE_ASKS})\n${summary}`
}

/** Pure: the held handoff in `ai_handoff_summary`, or null when there is none. */
export function parseAwaitingPhone(
  summary: string | null | undefined,
): { asks: number; summary: string } | null {
  const m = summary ? AWAITING_RE.exec(summary) : null
  if (!m) return null
  return { asks: Number(m[1]), summary: m[2] }
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

/** True when the conversation has a handoff on hold for the number. */
export async function isAwaitingPhoneHandoff(
  db: SupabaseClient,
  conversationId: string,
): Promise<boolean> {
  try {
    const { data } = await db
      .from('conversations')
      .select('ai_handoff_summary')
      .eq('id', conversationId)
      .maybeSingle()
    return parseAwaitingPhone(data?.ai_handoff_summary as string | null) !== null
  } catch {
    return false
  }
}

/**
 * Put a handoff on hold: ask for the number (unless the webhook's
 * button is already the last thing we sent — one ask per turn) and keep
 * the bot active with the marker. 'give_up' once MAX_PHONE_ASKS asks
 * went unanswered: the caller hands off for real, without the promise.
 */
export async function askPhoneBeforeHandoff(
  db: SupabaseClient,
  args: {
    accountId: string
    conversationId: string
    contactId: string
    userId: string
    summary: string
  },
): Promise<'asked' | 'give_up'> {
  const { data: conv } = await db
    .from('conversations')
    .select('ai_handoff_summary')
    .eq('id', args.conversationId)
    .maybeSingle()
  const asks = parseAwaitingPhone(conv?.ai_handoff_summary as string | null | undefined)?.asks ?? 0
  if (asks >= MAX_PHONE_ASKS) return 'give_up'
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
  await db
    .from('conversations')
    .update({
      ai_autoreply_disabled: false,
      ai_handoff_summary: awaitingPhoneSummary(asks + 1, args.summary),
    })
    .eq('id', args.conversationId)
  return 'asked'
}
