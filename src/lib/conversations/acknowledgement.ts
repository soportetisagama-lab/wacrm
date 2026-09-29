import type { SupabaseClient } from '@supabase/supabase-js'
import { engineSendText } from '@/lib/flows/meta-send'
import { isAcknowledgement, TRANSFER_FAREWELL_TEXT } from '@/lib/line-transfer-outbound'

/**
 * Every chat, not just transferred ones (line-transfer-outbound.ts): a
 * customer who only thanks / acknowledges / says goodbye ("ok gracias",
 * "👍", a sticker) must not get the welcome menu again. The bot answers
 * the same fixed farewell, at most MAX_FAREWELLS times within
 * FAREWELL_WINDOW_HOURS, then stays quiet.
 *
 * Only while the bot owns the chat: an assigned conversation is the
 * human's to answer, and a flow run waiting for input handles its own
 * replies. Best-effort — any failure returns null (normal path).
 */
const MAX_FAREWELLS = 2
const FAREWELL_WINDOW_HOURS = 24

export async function routeAcknowledgement(args: {
  db: SupabaseClient
  accountId: string
  userId: string
  conversationId: string
  contactId: string
  text: string
  isSticker: boolean
}): Promise<'acknowledged' | null> {
  try {
    if (!isAcknowledgement(args.text, args.isSticker)) return null

    const { data: conv } = await args.db
      .from('conversations')
      .select('assigned_agent_id')
      .eq('id', args.conversationId)
      .maybeSingle()
    if (conv?.assigned_agent_id) return null

    const { data: activeRuns } = await args.db
      .from('flow_runs')
      .select('id')
      .eq('contact_id', args.contactId)
      .eq('status', 'active')
      .limit(1)
    if (activeRuns && activeRuns.length > 0) return null

    const since = new Date(Date.now() - FAREWELL_WINDOW_HOURS * 3600_000).toISOString()
    const { count } = await args.db
      .from('messages')
      .select('id', { count: 'exact', head: true })
      .eq('conversation_id', args.conversationId)
      .eq('content_text', TRANSFER_FAREWELL_TEXT)
      .gte('created_at', since)
    if ((count ?? 0) < MAX_FAREWELLS) {
      await engineSendText({
        accountId: args.accountId,
        userId: args.userId,
        conversationId: args.conversationId,
        contactId: args.contactId,
        text: TRANSFER_FAREWELL_TEXT,
      })
    }
    return 'acknowledged'
  } catch (err) {
    console.error('[acknowledgement] routing failed:', err instanceof Error ? err.message : err)
    return null
  }
}
