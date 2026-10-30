import type { SupabaseClient } from '@supabase/supabase-js'
import { attentionFields } from './attention'

export type AssignResult =
  | { ok: true }
  /** `onlyIfUnassigned` was set and the chat was assigned or closed first. */
  | { ok: false; reason: 'already_assigned' }
  | { ok: false; reason: 'error'; error: unknown }

/**
 * Browser-side (re)assignment of a conversation, shared by the Inbox thread
 * and the Panel queue. Permissions and the assignee's notification live in
 * the database triggers on this UPDATE (migrations 027, 038, 065, 083).
 *
 * Handing the chat to someone else surfaces it for them like a fresh
 * WhatsApp message (top of the inbox + unread badge); taking it yourself or
 * unassigning leaves the order alone.
 *
 * `onlyIfUnassigned` is for screens showing a snapshot that may be stale: it
 * will not overwrite an assignment made after that snapshot was read, nor
 * touch a chat closed since then.
 */
export async function assignConversation(
  db: SupabaseClient,
  args: {
    conversationId: string
    agentId: string | null
    currentUserId: string | null | undefined
    currentUnread: number | null | undefined
    onlyIfUnassigned?: boolean
  },
): Promise<AssignResult> {
  const { conversationId, agentId, currentUserId, currentUnread, onlyIfUnassigned } = args
  const handedToSomeoneElse = !!agentId && agentId !== currentUserId
  const update = db
    .from('conversations')
    .update({
      assigned_agent_id: agentId,
      ...(handedToSomeoneElse ? attentionFields(currentUnread) : {}),
    })
    .eq('id', conversationId)

  if (onlyIfUnassigned) {
    const { data, error } = await update.is('assigned_agent_id', null).neq('status', 'closed').select('id')
    if (error) return { ok: false, reason: 'error', error }
    return data && data.length > 0 ? { ok: true } : { ok: false, reason: 'already_assigned' }
  }

  const { error } = await update
  return error ? { ok: false, reason: 'error', error } : { ok: true }
}
