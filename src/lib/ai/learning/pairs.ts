import type { SupabaseClient } from '@supabase/supabase-js'

// ============================================================
// Customer → reply pairs out of real chats, for the nightly learning
// jobs: customer → advisor (advisor learning, exam set) and
// customer → bot (self-review). Text-only; each line's own database,
// so nothing mixes between lines.
// ============================================================

export interface PairMessage {
  id: string
  conversation_id: string
  sender_type: 'customer' | 'agent' | 'bot'
  sender_id: string | null
  content_text: string | null
  transcript?: string | null
  created_at: string
}

export interface ReplyPair {
  conversationId: string
  /** First message of the reply (dedupe key in ai_learning_candidates). */
  messageId: string
  /** Who replied: 'agent' (human advisor) or 'bot'. */
  replier: 'agent' | 'bot'
  /** Advisor's user id (null for the bot). */
  replierId: string | null
  /** The customer's message(s) right before the reply, joined. */
  customerText: string
  /** Up to 4 earlier turns, oldest first, for context. */
  context: string[]
  replyText: string
  /** The customer's next message after the reply, if any. */
  followUp: string | null
  at: string
}

const MAX_TEXT = 700

function textOf(m: PairMessage): string {
  return (m.content_text || m.transcript || '').replace(/\s+/g, ' ').trim()
}

const SPEAKER: Record<PairMessage['sender_type'], string> = {
  customer: 'Cliente',
  agent: 'Asesor',
  bot: 'Bot',
}

/**
 * Pure: group one conversation's messages (any order) into pairs. A
 * pair is a run of customer messages followed by a run of replies from
 * the same kind of sender (advisor or bot).
 */
export function extractPairs(messages: PairMessage[]): ReplyPair[] {
  const rows = [...messages]
    .filter((m) => textOf(m))
    .sort((a, b) => a.created_at.localeCompare(b.created_at))
  const pairs: ReplyPair[] = []
  let i = 0
  while (i < rows.length) {
    if (rows[i].sender_type !== 'customer') {
      i += 1
      continue
    }
    const start = i
    const customer: string[] = []
    while (i < rows.length && rows[i].sender_type === 'customer') {
      customer.push(textOf(rows[i]))
      i += 1
    }
    if (i >= rows.length) break
    const first = rows[i]
    const replier = first.sender_type as 'agent' | 'bot'
    const reply: string[] = []
    while (i < rows.length && rows[i].sender_type === replier) {
      reply.push(textOf(rows[i]))
      i += 1
    }
    const next = i < rows.length && rows[i].sender_type === 'customer' ? textOf(rows[i]) : null
    const context = rows
      .slice(Math.max(0, start - 4), start)
      .map((m) => `${SPEAKER[m.sender_type]}: ${textOf(m).slice(0, 300)}`)
    pairs.push({
      conversationId: first.conversation_id,
      messageId: first.id,
      replier,
      replierId: replier === 'agent' ? first.sender_id : null,
      customerText: customer.join(' ').slice(0, MAX_TEXT),
      context,
      replyText: reply.join(' ').slice(0, MAX_TEXT),
      followUp: next ? next.slice(0, 300) : null,
      at: first.created_at,
    })
  }
  return pairs
}

const CONV_BATCH = 40
const MAX_CONVERSATIONS = 400
const MAX_MESSAGES_PER_BATCH = 3000

/**
 * Pairs from every conversation of the account with activity since
 * `since`. Only messages since `since` are paired (bounded work).
 */
export async function loadRecentPairs(
  db: SupabaseClient,
  accountId: string,
  since: Date,
): Promise<ReplyPair[]> {
  const { data: convs, error } = await db
    .from('conversations')
    .select('id')
    .eq('account_id', accountId)
    .gte('last_message_at', since.toISOString())
    .order('last_message_at', { ascending: false })
    .limit(MAX_CONVERSATIONS)
  if (error) throw new Error(`conversations: ${error.message}`)
  const ids = (convs ?? []).map((c) => c.id as string)
  const out: ReplyPair[] = []
  for (let k = 0; k < ids.length; k += CONV_BATCH) {
    const batch = ids.slice(k, k + CONV_BATCH)
    const { data: msgs, error: mErr } = await db
      .from('messages')
      .select('id, conversation_id, sender_type, sender_id, content_text, transcript, created_at')
      .in('conversation_id', batch)
      .gte('created_at', since.toISOString())
      .or('content_type.eq.text,content_type.eq.interactive,and(content_type.eq.audio,transcript.not.is.null)')
      .order('created_at', { ascending: true })
      .limit(MAX_MESSAGES_PER_BATCH)
    if (mErr) throw new Error(`messages: ${mErr.message}`)
    const byConv = new Map<string, PairMessage[]>()
    for (const m of (msgs ?? []) as PairMessage[]) {
      byConv.set(m.conversation_id, [...(byConv.get(m.conversation_id) ?? []), m])
    }
    for (const list of byConv.values()) out.push(...extractPairs(list))
  }
  return out
}
