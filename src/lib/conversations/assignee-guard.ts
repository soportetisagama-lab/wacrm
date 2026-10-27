import type { SupabaseClient } from '@supabase/supabase-js'
import { canBeAssignedConversation, channelOfRow } from '@/lib/auth/roles'

/**
 * Server-side check before a service-role write sets
 * `conversations.assigned_agent_id`: a Community Manager may only own
 * Messenger/Instagram conversations (see canBeAssignedConversation). The
 * database trigger rejects anything else, and that would fail the whole
 * UPDATE (status, ai_autoreply_disabled, …) — so callers drop the
 * assignee instead of sending it.
 *
 * The channel is only read when the assignee is a Community Manager, so
 * nothing changes for the other roles. Any read error counts as "not
 * allowed" for a Community Manager (fail closed).
 */
export async function isCommunityManagerUser(
  db: SupabaseClient,
  userId: string,
): Promise<boolean> {
  const { data } = await db
    .from('profiles')
    .select('account_role')
    .eq('user_id', userId)
    .maybeSingle()
  return (data as { account_role?: string } | null)?.account_role === 'community_manager'
}

/** Channel of a conversation, or null when it can't be read. */
async function readChannel(
  db: SupabaseClient,
  table: 'conversations' | 'contacts',
  id: string,
): Promise<string | null> {
  const { data, error } = await db.from(table).select('channel').eq('id', id).maybeSingle()
  if (error) return null
  return channelOfRow(data)
}

/** May `agentId` be assigned the conversation `conversationId`? */
export async function canAssignAgentToConversation(
  db: SupabaseClient,
  agentId: string,
  conversationId: string,
): Promise<boolean> {
  if (!(await isCommunityManagerUser(db, agentId))) return true
  const channel = await readChannel(db, 'conversations', conversationId)
  return canBeAssignedConversation('community_manager', channel)
}

/** Same, by contact (its conversations share the contact's channel). */
export async function canAssignAgentToContact(
  db: SupabaseClient,
  agentId: string,
  contactId: string,
): Promise<boolean> {
  if (!(await isCommunityManagerUser(db, agentId))) return true
  const channel = await readChannel(db, 'contacts', contactId)
  return canBeAssignedConversation('community_manager', channel)
}

/** Channel of a contact, or null (treated as WhatsApp). */
export function contactChannel(db: SupabaseClient, contactId: string): Promise<string | null> {
  return readChannel(db, 'contacts', contactId)
}
