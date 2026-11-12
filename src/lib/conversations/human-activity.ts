import type { SupabaseClient } from '@supabase/supabase-js'
import { TRANSFER_NOTICE_PREFIX } from '@/lib/line-transfer'

/** How long a manual reply from a teammate keeps the bots (Flows welcome
 *  menu, AI auto-reply) quiet on an unassigned conversation — the same
 *  24 h as WhatsApp's customer-service window. */
export const HUMAN_REPLY_QUIET_HOURS = 24

/**
 * True when a teammate wrote in this conversation by hand within the last
 * HUMAN_REPLY_QUIET_HOURS. Human sends (and the few canned texts of
 * isAutomaticAgentText) are the only `sender_type: 'agent'`
 * messages — Flows, automations and the AI assistant all write 'bot'.
 *
 * Without this, a reply that didn't assign the conversation only paused
 * the bot until the customer's next message: the `returning_message`
 * trigger then started a fresh run and re-sent "Sigue explorando nuestro
 * menú…" right after a human had answered. Fails open (false) on a read
 * error so a DB hiccup never silences the bot for good.
 */
export async function hasRecentHumanReply(
  db: SupabaseClient,
  conversationId: string,
  hours: number = HUMAN_REPLY_QUIET_HOURS,
): Promise<boolean> {
  const since = new Date(Date.now() - hours * 3600_000).toISOString()
  try {
    const { data, error } = await db
      .from('messages')
      .select('id')
      .eq('conversation_id', conversationId)
      .eq('sender_type', 'agent')
      .gte('created_at', since)
      .limit(1)
    if (error) {
      console.error('[human-activity] recent human reply lookup failed:', error.message)
      return false
    }
    return (data?.length ?? 0) > 0
  } catch (err) {
    console.error('[human-activity] recent human reply lookup threw:', err)
    return false
  }
}

/** How long after our last outgoing message (bot or human) a customer's
 *  text still counts as the same conversation, not a new visit. */
export const ONGOING_CONVERSATION_HOURS = 6

/**
 * True when we sent anything to this conversation within the last
 * ONGOING_CONVERSATION_HOURS. The `returning_message` welcome uses it to
 * stay quiet mid-conversation (the AI answers instead of re-sending
 * "Sigue explorando nuestro menú…"). Fails open (false) on a read error.
 */
export async function hasRecentOutgoingMessage(
  db: SupabaseClient,
  conversationId: string,
  hours: number = ONGOING_CONVERSATION_HOURS,
): Promise<boolean> {
  const since = new Date(Date.now() - hours * 3600_000).toISOString()
  try {
    const { data, error } = await db
      .from('messages')
      .select('id')
      .eq('conversation_id', conversationId)
      .neq('sender_type', 'customer')
      .gte('created_at', since)
      .limit(1)
    if (error) {
      console.error('[human-activity] recent outgoing lookup failed:', error.message)
      return false
    }
    return (data?.length ?? 0) > 0
  } catch (err) {
    console.error('[human-activity] recent outgoing lookup threw:', err)
    return false
  }
}

/** What the outbound-call route stores when it asks the customer for
 *  call permission (`sender_type: 'agent'`, but a canned Meta prompt —
 *  not the advisor writing). */
export const CALL_PERMISSION_TEXT =
  'Hola 👋 ¿Nos permites llamarte por WhatsApp para atenderte mejor?'
export const CALL_PERMISSION_MESSAGE = `📞 ${CALL_PERMISSION_TEXT}`

/** Before this date some human sends were stored without `sender_id`
 *  (it is recorded since migration 075); after it, an 'agent' row with
 *  no `sender_id` is a public-API send (e.g. another line's transfer
 *  template), never the advisor typing. */
export const SENDER_ID_RELIABLE_SINCE = '2026-11-13'

/** 'agent' rows written for the advisor by an automatic step, not typed. */
export function isAutomaticAgentText(text: string | null | undefined): boolean {
  if (!text) return false
  return text.startsWith(CALL_PERMISSION_MESSAGE) || text.startsWith(TRANSFER_NOTICE_PREFIX)
}

/**
 * True when the "Take over" pause (or any pause that isn't a handoff) is
 * on: `ai_autoreply_disabled` with the conversation NOT in 'pending'.
 * Every handoff writer (AI assistant, Flows, social fallback) sets
 * 'pending' together with the pause; the inbox "Take over" moves it to
 * 'open', and an advisor's send does too (lib/whatsapp/send-message.ts).
 */
export function isManualAiPause(conv: {
  ai_autoreply_disabled?: boolean | null
  status?: string | null
}): boolean {
  return conv.ai_autoreply_disabled === true && conv.status !== 'pending'
}

/**
 * True when the assigned advisor already wrote in this conversation by
 * hand: a `sender_type: 'agent'` row with `sender_id` = that advisor
 * (or, for rows older than SENDER_ID_RELIABLE_SINCE, with no sender_id),
 * excluding the automatic texts of isAutomaticAgentText. Until then the
 * AI keeps serving an assigned chat; from then on it stays quiet for as
 * long as the chat keeps that advisor. Messages of a previous assignee
 * don't count. Fails toward true (quiet) on a read error, so a DB hiccup
 * never makes the bot talk over an advisor.
 */
export async function assignedAdvisorHasReplied(
  db: SupabaseClient,
  conversationId: string,
  assignedAgentId: string,
): Promise<boolean> {
  try {
    const { data, error } = await db
      .from('messages')
      .select('content_text')
      .eq('conversation_id', conversationId)
      .eq('sender_type', 'agent')
      .or(
        `sender_id.eq.${assignedAgentId},and(sender_id.is.null,created_at.lt.${SENDER_ID_RELIABLE_SINCE})`,
      )
      .order('created_at', { ascending: false })
      .limit(20)
    if (error) {
      console.error('[human-activity] advisor reply lookup failed:', error.message)
      return true
    }
    return ((data ?? []) as { content_text: string | null }[]).some(
      (m) => !isAutomaticAgentText(m.content_text),
    )
  } catch (err) {
    console.error('[human-activity] advisor reply lookup threw:', err)
    return true
  }
}
