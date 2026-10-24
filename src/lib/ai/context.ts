import type { SupabaseClient } from '@supabase/supabase-js'
import type { ChatMessage } from './types'
import { aiContextMessageLimit } from './defaults'
import { fetchImageBlock } from './image-block'
import { ADVISOR_TAG, LOCATION_TAG, LONG_GAP_MS, formatContextTimestamp } from './annotations'

interface DbMessage {
  sender_type: 'customer' | 'agent' | 'bot'
  content_type:
    | 'text'
    | 'audio'
    | 'image'
    | 'interactive'
    | 'template'
    | 'location'
    | 'document'
    | 'video'
  content_text: string | null
  transcript: string | null
  created_at?: string | null
  filename?: string | null
  /** Options of a menu the business sent (migration 035). */
  interactive_payload?: unknown
  /** Only selected when `includeImages` is true (see below). */
  media_storage_url?: string | null
  is_sticker?: boolean
}

interface PayloadOption {
  title?: unknown
  description?: unknown
}

/** "Opciones: 1) Cotizar 2) Catálogo" for a buttons/list menu the
 *  business sent, so a reply like "la 2" or an option's name makes
 *  sense to the model. Empty when there's no usable payload. */
export function menuOptionsText(payload: unknown): string {
  if (!payload || typeof payload !== 'object') return ''
  const p = payload as { buttons?: PayloadOption[]; sections?: { rows?: PayloadOption[] }[] }
  const options: PayloadOption[] = Array.isArray(p.buttons)
    ? p.buttons
    : Array.isArray(p.sections)
      ? p.sections.flatMap((s) => (Array.isArray(s?.rows) ? s.rows : []))
      : []
  const titles = options
    .map((o) => {
      const title = typeof o?.title === 'string' ? o.title.trim() : ''
      const desc = typeof o?.description === 'string' ? o.description.trim() : ''
      return title ? (desc ? `${title} (${desc})` : title) : ''
    })
    .filter(Boolean)
  if (titles.length === 0) return ''
  return `Opciones: ${titles.map((t, i) => `${i + 1}) ${t}`).join(' ')}`
}

/**
 * Fetch the last N text-bearing (and, opt-in, image-bearing) messages
 * of a conversation and map them to the provider-neutral chat shape.
 * Customer messages become `user`; agent and bot messages become
 * `assistant` (a human advisor's turns prefixed with `[Asesor]`). Also
 * surfaced: a location the customer shared, files the business sent
 * ("[Se envió: catalogo.pdf]"), the options of a menu the business
 * sent, and a date/time stamp on the first turn and after long pauses.
 * Ordered oldest-first (chronological) so the transcript
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
 * selected in the first place. A sent template (content_type='template')
 * counts too when its rendered body was stored as content_text (see
 * send-message.ts) — e.g. a line-transfer opener the customer is
 * replying to; older template rows with no text are dropped as blank.
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
  const base = 'sender_type, content_type, content_text, transcript, created_at, filename, interactive_payload'
  const columns: string = includeImages ? `${base}, media_storage_url, is_sticker` : base
  const common =
    'content_type.eq.text,content_type.eq.interactive,content_type.eq.template,content_type.eq.location,' +
    'and(content_type.eq.audio,transcript.not.is.null),' +
    'and(sender_type.neq.customer,content_type.eq.document),and(sender_type.neq.customer,content_type.eq.video)'
  const filter = includeImages
    ? `${common},content_type.eq.image`
    : `${common},and(sender_type.neq.customer,content_type.eq.image)`

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
  const built = await Promise.all(
    rows.map((m, i) => buildMessage(m, includeImages, stampFor(rows, i))),
  )
  return built.filter((m): m is ChatMessage => m !== null)
}

/** Date/time stamp for row `i`: on the first row and whenever the gap
 *  since the previous row is long. Null without a created_at. */
function stampFor(rows: DbMessage[], i: number): string | null {
  const at = rows[i].created_at ? new Date(rows[i].created_at as string) : null
  if (!at || Number.isNaN(at.getTime())) return null
  const prev = i > 0 && rows[i - 1].created_at ? new Date(rows[i - 1].created_at as string) : null
  if (i === 0 || (prev && at.getTime() - prev.getTime() >= LONG_GAP_MS)) {
    return formatContextTimestamp(at)
  }
  return null
}

function withPrefix(prefix: string, text: string): string {
  return prefix ? `${prefix} ${text}` : text
}

const FILE_KIND_LABEL: Record<'document' | 'video' | 'image', string> = {
  document: 'un documento',
  video: 'un video',
  image: 'una imagen',
}

async function buildMessage(
  m: DbMessage,
  includeImages: boolean,
  stamp: string | null,
): Promise<ChatMessage | null> {
  const fromCustomer = m.sender_type === 'customer'
  const role = fromCustomer ? ('user' as const) : ('assistant' as const)
  const prefix = [stamp, m.sender_type === 'agent' ? ADVISOR_TAG : null].filter(Boolean).join(' ')

  // A file the business sent (catalog, brochure, photo, video): the model
  // can't see it, but must know it already went out.
  if (
    !fromCustomer &&
    (m.content_type === 'document' || m.content_type === 'video' || m.content_type === 'image')
  ) {
    const caption = m.content_text?.trim()
    const name = m.filename?.trim() || caption || FILE_KIND_LABEL[m.content_type]
    const note = `[Se envió: ${name}]${caption && caption !== name ? ` ${caption}` : ''}`
    return { role, content: withPrefix(prefix, note) }
  }

  if (m.content_type === 'image') {
    // Belt-and-suspenders: the SQL filter above already excludes
    // customer image rows entirely when includeImages is false, but
    // this function shouldn't rely on that alone.
    if (!includeImages) return null
    if (m.is_sticker) return null

    const caption = m.content_text?.trim() || null
    const captionText = caption ? withPrefix(prefix, caption) : prefix
    const image = m.media_storage_url ? await fetchImageBlock(m.media_storage_url) : null
    if (!image) {
      // No usable copy (download failed or still missing): say so, so
      // the model asks about it instead of answering as if nothing came.
      return {
        role,
        content: caption
          ? captionText
          : withPrefix(prefix, '[El cliente envió una foto que no se pudo abrir]'),
      }
    }
    return {
      role,
      content: captionText ? [image, { type: 'text', text: captionText }] : [image],
    }
  }

  if (m.content_type === 'location') {
    const text = m.content_text?.trim()
    return text ? { role, content: withPrefix(prefix, `${LOCATION_TAG} ${text}`) } : null
  }

  const raw = (m.content_type === 'audio' ? m.transcript : m.content_text)?.trim() ?? ''
  const options =
    !fromCustomer && m.content_type === 'interactive' ? menuOptionsText(m.interactive_payload) : ''
  const text = [raw, options].filter(Boolean).join('\n')
  return text ? { role, content: withPrefix(prefix, text) } : null
}
