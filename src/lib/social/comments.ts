// ============================================================
// Automatic replies to comments on the Facebook Page / Instagram account.
//
// For each new comment (lib/social/parse.ts → parseSocialComments):
//   1. resolve the account by (channel, entry.id) and check the admin
//      turned "Responder comentarios automáticamente" on (migration 085);
//   2. claim the comment_id in social_comment_replies (Meta redelivers);
//   3. apply the limits per person and post: one private message ever
//      (Meta allows one per comment, within 7 days) and one public reply
//      every 24 h — someone who comments 5 times gets answered once;
//   4. send the public reply and the private message independently: if
//      one fails the other still goes. Errors are logged and stored.
// When the person answers the private message, it arrives as a normal
// DM and goes through lib/social/inbound.ts (bandeja, bot, derivación).
// Texts never carry prices (checked on save and again here).
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'

import { supabaseAdmin } from '@/lib/flows/admin-client'
import { decrypt } from '@/lib/whatsapp/encryption'
import { isUniqueViolation } from '@/lib/contacts/dedupe'
import { hasPrice } from '@/lib/ai/learning/guards'
import { GraphApiError, replyToComment, sendPrivateReply } from './graph'
import { parseSocialComments, type SocialCommentEvent } from './parse'

// The Community Manager serves these chats first: no text promises an
// advisor. The private message asks for the number right away, the same
// ask the bot makes before any handoff (lib/ai/awaiting-phone).
export const DEFAULT_COMMENT_PUBLIC_REPLY = '¡Hola! Te escribimos por mensaje privado 👋'
export const DEFAULT_COMMENT_PRIVATE_REPLY =
  '¡Hola! Vimos tu comentario 😊 Para ayudarte mejor, ¿nos compartes tu número de celular?'

// Letter-aware end (\b would treat the "í" of "asesoría" as a boundary).
const PROMISES_ADVISOR_RE = /\basesor(?:a|es|as)?(?![\p{L}])/iu

/** Max length accepted for each editable text. */
export const COMMENT_REPLY_MAX_LENGTH = 900

const PUBLIC_COOLDOWN_MS = 24 * 60 * 60 * 1000
const PRIVATE_REPLY_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000

export interface CommentReplyConfig {
  account_id: string
  channel: 'instagram' | 'messenger'
  page_id: string
  access_token: string
  enabled: boolean
  comment_replies_enabled?: boolean | null
  comment_public_reply?: string | null
  comment_private_reply?: string | null
}

export function commentReplyTexts(config: Pick<CommentReplyConfig, 'comment_public_reply' | 'comment_private_reply'>) {
  return {
    publicText: config.comment_public_reply?.trim() || DEFAULT_COMMENT_PUBLIC_REPLY,
    privateText: config.comment_private_reply?.trim() || DEFAULT_COMMENT_PRIVATE_REPLY,
  }
}

/** Validation for a text the admin saves. Returns an error message or null. */
export function commentReplyTextError(text: string): string | null {
  if (text.length > COMMENT_REPLY_MAX_LENGTH) {
    return `El texto puede tener hasta ${COMMENT_REPLY_MAX_LENGTH} caracteres.`
  }
  if (hasPrice(text)) return 'Los textos automáticos no pueden incluir precios ni montos.'
  if (PROMISES_ADVISOR_RE.test(text)) {
    return 'Los textos automáticos no pueden prometer un asesor: estos chats los atiende primero el Community Manager.'
  }
  return null
}

export type CommentOutcome =
  | 'disabled'
  | 'duplicate'
  | { public: 'sent' | 'skipped' | 'failed'; private: 'sent' | 'skipped' | 'failed' }

function errMessage(err: unknown): string {
  if (err instanceof GraphApiError) {
    return `${err.message} (code=${err.code ?? '-'} subcode=${err.subcode ?? '-'})`
  }
  return err instanceof Error ? err.message : String(err)
}

export async function processSocialCommentsBody(body: unknown): Promise<void> {
  const comments = parseSocialComments(body)
  for (const comment of comments) {
    try {
      await processSocialComment(supabaseAdmin(), comment)
    } catch (err) {
      console.error(`[social-webhook] ${comment.channel} comment ${comment.commentId} failed:`, err)
    }
  }
}

export async function processSocialComment(
  db: SupabaseClient,
  comment: SocialCommentEvent,
  now: number = Date.now(),
): Promise<CommentOutcome> {
  const { data: cfgData, error: cfgError } = await db
    .from('social_channel_configs')
    .select('*')
    .eq('channel', comment.channel)
    .eq('external_id', comment.externalId)
    .maybeSingle()
  if (cfgError) {
    console.error('[social-webhook] comment config lookup failed:', cfgError.message)
    return 'disabled'
  }
  const config = cfgData as CommentReplyConfig | null
  if (!config || !config.enabled || config.comment_replies_enabled !== true) return 'disabled'

  // 2. Claim the comment (PRIMARY KEY channel + comment_id).
  const { error: claimError } = await db.from('social_comment_replies').insert({
    channel: comment.channel,
    comment_id: comment.commentId,
    account_id: config.account_id,
    post_id: comment.postId,
    commenter_id: comment.commenterId,
  })
  if (claimError) {
    if (!isUniqueViolation(claimError)) {
      console.error(`[social-webhook] comment claim failed — ${comment.commentId} skipped:`, claimError.message)
    }
    return 'duplicate'
  }

  // 3. Limits per person and post (other comments of the same person).
  let earlier = db
    .from('social_comment_replies')
    .select('comment_id, public_sent_at, private_sent_at')
    .eq('account_id', config.account_id)
    .eq('channel', comment.channel)
    .eq('commenter_id', comment.commenterId)
    .neq('comment_id', comment.commentId)
  earlier = comment.postId ? earlier.eq('post_id', comment.postId) : earlier.is('post_id', null)
  const { data: prevData } = await earlier
  const prev = (prevData ?? []) as Array<{ public_sent_at: string | null; private_sent_at: string | null }>
  const cutoff = now - PUBLIC_COOLDOWN_MS
  const publicRecently = prev.some((r) => r.public_sent_at && Date.parse(r.public_sent_at) >= cutoff)
  const privateAlready = prev.some((r) => r.private_sent_at)

  const { publicText, privateText } = commentReplyTexts(config)
  const wantPublic = !comment.live && !publicRecently && !hasPrice(publicText)
  const wantPrivate =
    !privateAlready && now - comment.timestamp <= PRIVATE_REPLY_MAX_AGE_MS && !hasPrice(privateText)

  if (!wantPublic && !wantPrivate) return { public: 'skipped', private: 'skipped' }

  // Reserve before calling Meta, so a burst of comments from the same
  // person (separate webhook deliveries) doesn't all pass the check.
  const stamp = new Date(now).toISOString()
  await db
    .from('social_comment_replies')
    .update({
      ...(wantPublic ? { public_sent_at: stamp } : {}),
      ...(wantPrivate ? { private_sent_at: stamp } : {}),
    })
    .eq('channel', comment.channel)
    .eq('comment_id', comment.commentId)

  let accessToken: string
  try {
    accessToken = decrypt(config.access_token)
  } catch {
    console.error(`[social-webhook] ${comment.channel}: page token unreadable — comment ${comment.commentId} not answered`)
    await db
      .from('social_comment_replies')
      .update({ public_sent_at: null, private_sent_at: null, public_error: 'token', private_error: 'token' })
      .eq('channel', comment.channel)
      .eq('comment_id', comment.commentId)
    return { public: wantPublic ? 'failed' : 'skipped', private: wantPrivate ? 'failed' : 'skipped' }
  }

  // 4. Both sends, independent of each other.
  const result: { public: 'sent' | 'skipped' | 'failed'; private: 'sent' | 'skipped' | 'failed' } = {
    public: 'skipped',
    private: 'skipped',
  }
  const patch: Record<string, unknown> = {}

  if (wantPublic) {
    try {
      patch.public_reply_id = await replyToComment({
        channel: comment.channel,
        commentId: comment.commentId,
        message: publicText,
        accessToken,
      })
      result.public = 'sent'
    } catch (err) {
      const msg = errMessage(err)
      console.error(`[social-webhook] ${comment.channel}: public reply to comment ${comment.commentId} failed: ${msg}`)
      patch.public_sent_at = null
      patch.public_error = msg.slice(0, 500)
      result.public = 'failed'
    }
  }

  if (wantPrivate) {
    try {
      patch.private_message_id = await sendPrivateReply({
        pageId: config.page_id,
        commentId: comment.commentId,
        text: privateText,
        accessToken,
      })
      result.private = 'sent'
    } catch (err) {
      const msg = errMessage(err)
      console.error(`[social-webhook] ${comment.channel}: private reply to comment ${comment.commentId} failed: ${msg}`)
      patch.private_sent_at = null
      patch.private_error = msg.slice(0, 500)
      result.private = 'failed'
    }
  }

  const { error: saveError } = await db
    .from('social_comment_replies')
    .update(patch)
    .eq('channel', comment.channel)
    .eq('comment_id', comment.commentId)
  if (saveError) console.error('[social-webhook] comment reply log failed:', saveError.message)

  console.log(
    `[social-webhook] ${comment.channel} comment ${comment.commentId}: public=${result.public} private=${result.private}`,
  )
  return result
}
