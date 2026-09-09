import type { SupabaseClient } from '@supabase/supabase-js'
import type { ChatMessage } from './types'
import { aiContextMessageLimit } from './defaults'

interface DbMessage {
  sender_type: 'customer' | 'agent' | 'bot'
  content_type: 'text' | 'audio'
  content_text: string | null
  transcript: string | null
}

/**
 * Fetch the last N text-bearing messages of a conversation and map them
 * to the provider-neutral chat shape. Customer messages become `user`;
 * agent and bot messages become `assistant`. Non-text messages (media,
 * templates, interactive) are excluded — they carry no text to model,
 * EXCEPT a transcribed voice note (content_type='audio' with a non-null
 * `transcript`), whose transcript is used as if it were content_text —
 * see `transcribeInboundAudio` (lib/ai/auto-reply.ts), the only writer
 * of that column. A transcript of `''` (Whisper ran, got nothing) is
 * fetched too but then dropped by the same blank-content filter below
 * as any other empty message, same as `transcript IS NULL` never being
 * selected in the first place.
 *
 * Ordered oldest-first (chronological) so the transcript reads
 * naturally and the most recent customer message lands last.
 */
export async function buildConversationContext(
  db: SupabaseClient,
  conversationId: string,
  limit: number = aiContextMessageLimit(),
): Promise<ChatMessage[]> {
  const { data, error } = await db
    .from('messages')
    .select('sender_type, content_type, content_text, transcript')
    .eq('conversation_id', conversationId)
    .or('content_type.eq.text,and(content_type.eq.audio,transcript.not.is.null)')
    .order('created_at', { ascending: false })
    .limit(limit)

  if (error) throw error

  const rows = ((data ?? []) as DbMessage[]).reverse()
  return rows
    .map((m) => ({
      role: m.sender_type === 'customer' ? ('user' as const) : ('assistant' as const),
      text: m.content_type === 'audio' ? m.transcript : m.content_text,
    }))
    .filter((m) => m.text && m.text.trim())
    .map((m) => ({
      role: m.role,
      content: m.text!.trim(),
    }))
}
