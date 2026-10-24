import type { SupabaseClient } from '@supabase/supabase-js'

/** How long a manual reply from a teammate keeps the bots (Flows welcome
 *  menu, AI auto-reply) quiet on an unassigned conversation — the same
 *  24 h as WhatsApp's customer-service window. */
export const HUMAN_REPLY_QUIET_HOURS = 24

/**
 * True when a teammate wrote in this conversation by hand within the last
 * HUMAN_REPLY_QUIET_HOURS. Human sends are the only `sender_type: 'agent'`
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
