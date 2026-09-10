import type { SupabaseClient } from '@supabase/supabase-js'
import type { ChatMessage } from './types'
import { aiContextMessageLimit } from './defaults'
import { fetchImageBlock } from './image-block'

interface DbMessage {
  sender_type: 'customer' | 'agent' | 'bot'
  content_type: 'text' | 'audio' | 'image' | 'interactive'
  content_text: string | null
  transcript: string | null
  /** Only selected when `includeImages` is true (see below). */
  media_storage_url?: string | null
  is_sticker?: boolean
}

/**
 * Fetch the last N text-bearing (and, opt-in, image-bearing) messages
 * of a conversation and map them to the provider-neutral chat shape.
 * Customer messages become `user`; agent and bot messages become
 * `assistant`. Ordered oldest-first (chronological) so the transcript
 * reads naturally and the most recent customer message lands last.
 *
 * Text handling (unchanged regardless of `includeImages`): non-text
 * messages (media, templates) are excluded — they carry no text to
 * model, EXCEPT a transcribed voice note (content_type='audio' with a
 * non-null `transcript`), whose transcript is used as if it were
 * content_text — see `transcribeInboundAudio` (lib/ai/inbound-audio.ts),
 * the only writer of that column — and a button/list tap
 * (content_type='interactive'), whose `content_text` already holds the
 * tapped option's human-readable title (e.g. "🖼️ Catálogo digital",
 * set by the webhook same as any other message). Without this, a tap
 * that no Flow run was left to consume was invisible to the model
 * entirely — it would see whatever text came before the tap, never the
 * tap itself. A transcript of `''` (Whisper ran, got nothing) is
 * fetched too but then dropped by the same blank-content filter as any
 * other empty message, same as `transcript IS NULL` never being
 * selected in the first place.
 *
 * `includeImages` (default false — every existing caller gets today's
 * exact behavior, unchanged) opts into also surfacing content_type=
 * 'image' rows as vision content: a real photo with a persisted
 * Storage copy (`media_storage_url`, written by `persistInboundImage`
 * — lib/ai/inbound-image.ts) becomes an image ContentBlock, plus a
 * text block for its caption if any. A sticker (`is_sticker`) is
 * EXCLUDED even with `includeImages: true` — never spend vision on
 * decoration, and this is the second of two independent guards (the
 * first is that `persistInboundImage` never uploads a sticker in the
 * first place, so `media_storage_url` is always null for one anyway).
 * An image row with no persisted copy yet (sourcing pending or
 * failed) degrades to caption-only, or drops entirely if there's no
 * caption — no retry, no call to Meta from here (that's the whole
 * point of persisting a copy up front: this function never needs
 * Meta credentials).
 */
export async function buildConversationContext(
  db: SupabaseClient,
  conversationId: string,
  limit: number = aiContextMessageLimit(),
  opts: { includeImages?: boolean } = {},
): Promise<ChatMessage[]> {
  const { includeImages = false } = opts

  // Typed as plain `string` (not narrowed to either literal) so
  // supabase-js's select-string type parser widens instead of trying
  // to statically parse a union of the two branches.
  const columns: string = includeImages
    ? 'sender_type, content_type, content_text, transcript, media_storage_url, is_sticker'
    : 'sender_type, content_type, content_text, transcript'
  const filter = includeImages
    ? 'content_type.eq.text,content_type.eq.interactive,and(content_type.eq.audio,transcript.not.is.null),content_type.eq.image'
    : 'content_type.eq.text,content_type.eq.interactive,and(content_type.eq.audio,transcript.not.is.null)'

  const { data, error } = await db
    .from('messages')
    .select(columns)
    .eq('conversation_id', conversationId)
    .or(filter)
    .order('created_at', { ascending: false })
    .limit(limit)

  if (error) throw error

  // A dynamic (non-literal) `columns` string defeats supabase-js's
  // select-string type parser (GenericStringError) — go through
  // `unknown` same as TS suggests; DbMessage is the real contract here.
  const rows = ((data ?? []) as unknown as DbMessage[]).reverse()
  const built = await Promise.all(rows.map((m) => buildMessage(m, includeImages)))
  return built.filter((m): m is ChatMessage => m !== null)
}

async function buildMessage(m: DbMessage, includeImages: boolean): Promise<ChatMessage | null> {
  const role = m.sender_type === 'customer' ? ('user' as const) : ('assistant' as const)

  if (m.content_type === 'image') {
    // Belt-and-suspenders: the SQL filter above already excludes
    // content_type='image' rows entirely when includeImages is false,
    // but this function shouldn't rely on that alone — an image row
    // reaching here with the flag off is treated exactly as it was
    // before this feature existed (not present in context at all).
    if (!includeImages) return null
    if (m.is_sticker) return null

    const caption = m.content_text?.trim() || null
    if (!m.media_storage_url) {
      return caption ? { role, content: caption } : null
    }

    const image = await fetchImageBlock(m.media_storage_url)
    if (!image) return caption ? { role, content: caption } : null
    return { role, content: caption ? [image, { type: 'text', text: caption }] : [image] }
  }

  const text = m.content_type === 'audio' ? m.transcript : m.content_text
  return text && text.trim() ? { role, content: text.trim() } : null
}
