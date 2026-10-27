// ============================================================
// Instagram / Messenger webhook payloads → normalized inbound events.
//
// Pure (no I/O) so it's unit-testable. Both products deliver through
// Meta's Messenger Platform with the same envelope:
//
//   { object: 'page' | 'instagram',
//     entry: [{ id, time, messaging: [ <event>, … ] }] }
//
// `entry.id` is the Facebook Page id (Messenger) or the Instagram
// professional account id (Instagram) — the key social_channel_configs
// stores as `external_id`. Each messaging event carries `sender.id`
// (PSID / IGSID) and one of: `message`, `postback`, `referral`,
// `reaction`, `read`, `delivery`… Only the ones the CRM uses are mapped;
// everything else becomes `null` and is skipped.
// ============================================================

import type { SocialChannel } from '@/lib/channels/types'

export interface SocialAttachment {
  /** 'image' | 'video' | 'audio' | 'file' | 'sticker' | 'share' | 'story_mention' | … */
  type: string
  url: string | null
}

export interface SocialReferral {
  ad_id: string | null
  ref: string | null
  source: string | null
  type: string | null
  headline: string | null
  image_url: string | null
  video_url: string | null
  source_url: string | null
  raw: Record<string, unknown>
}

export interface SocialInboundEvent {
  channel: SocialChannel
  /** entry.id — page id (Messenger) / IG account id (Instagram). */
  externalId: string
  /** PSID / IGSID of the person writing. */
  senderId: string
  /** Meta's message id. Synthesized for postbacks without one. */
  mid: string
  timestamp: number
  kind: 'message' | 'postback' | 'referral'
  text: string | null
  attachments: SocialAttachment[]
  /** quick_reply.payload or postback.payload — the option id we sent. */
  replyPayload: string | null
  /** Mid of the message this one replies to (swipe-reply), if any. */
  replyToMid: string | null
  referral: SocialReferral | null
  /** Instagram: content Meta withholds (e.g. some story types). */
  unsupported: boolean
  /**
   * Delivered as `standby`: another app (Meta's inbox, Meta Business AI…)
   * controls the thread through the handover protocol / conversation
   * routing. Stored like any message; the next send takes thread control.
   */
  standby?: boolean
}

interface RawEnvelope {
  object?: string
  entry?: Array<{
    id?: string
    time?: number
    messaging?: Array<Record<string, unknown>>
    standby?: Array<Record<string, unknown>>
    changes?: Array<Record<string, unknown>>
  }>
}

/** Webhook `object` → our channel. Unknown objects return null (ignored). */
export function channelForObject(object: unknown): SocialChannel | null {
  if (object === 'page') return 'messenger'
  if (object === 'instagram') return 'instagram'
  return null
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null
}

function obj(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

export function parseReferral(value: unknown): SocialReferral | null {
  const r = obj(value)
  if (!r) return null
  const ads = obj(r.ads_context_data) ?? {}
  return {
    ad_id: str(r.ad_id),
    ref: str(r.ref),
    source: str(r.source),
    type: str(r.type),
    headline: str(ads.ad_title),
    image_url: str(ads.photo_url),
    video_url: str(ads.video_url),
    source_url: str(r.source_url) ?? str(ads.post_id),
    raw: r,
  }
}

function parseAttachments(value: unknown): SocialAttachment[] {
  if (!Array.isArray(value)) return []
  const out: SocialAttachment[] = []
  for (const item of value) {
    const a = obj(item)
    if (!a) continue
    const payload = obj(a.payload) ?? {}
    const type = str(a.type) ?? 'file'
    // Messenger stickers arrive as type 'image' with payload.sticker_id.
    const isSticker = payload.sticker_id != null
    out.push({ type: isSticker ? 'sticker' : type, url: str(payload.url) })
  }
  return out
}

/**
 * Normalize one webhook body. Echoes (`message.is_echo` — messages the
 * page itself sent, including ours), deleted messages, reads, deliveries
 * and reactions are dropped: the CRM already stores what it sends.
 */
export function parseSocialWebhook(body: unknown): SocialInboundEvent[] {
  const env = obj(body) as RawEnvelope | null
  if (!env) return []
  const channel = channelForObject(env.object)
  if (!channel || !Array.isArray(env.entry)) return []

  const events: SocialInboundEvent[] = []
  for (const entry of env.entry) {
    const externalId = str(entry?.id)
    if (!externalId) continue
    const items: Array<{ raw: unknown; standby: boolean }> = [
      ...(Array.isArray(entry.messaging) ? entry.messaging : []).map((raw) => ({ raw, standby: false })),
      ...(Array.isArray(entry.standby) ? entry.standby : []).map((raw) => ({ raw, standby: true })),
    ]

    for (const { raw, standby } of items) {
      const ev = obj(raw)
      if (!ev) continue
      const senderId = str(obj(ev.sender)?.id)
      if (!senderId) continue
      // Our own page writing (echo) — sender is the page/IG account itself.
      if (senderId === externalId) continue
      const timestamp = typeof ev.timestamp === 'number' ? ev.timestamp : Date.now()

      const message = obj(ev.message)
      if (message) {
        if (message.is_echo === true || message.is_deleted === true) continue
        const mid = str(message.mid)
        if (!mid) continue
        events.push({
          channel,
          externalId,
          senderId,
          mid,
          timestamp,
          kind: 'message',
          text: str(message.text),
          attachments: parseAttachments(message.attachments),
          replyPayload: str(obj(message.quick_reply)?.payload),
          replyToMid: str(obj(message.reply_to)?.mid),
          referral: parseReferral(message.referral) ?? parseReferral(ev.referral),
          unsupported: message.is_unsupported === true,
          ...(standby ? { standby: true } : {}),
        })
        continue
      }
      // Standby: only the customer's own messages matter (echoes were
      // dropped above; postbacks/referrals belong to the controlling app).
      if (standby) continue

      const postback = obj(ev.postback)
      if (postback) {
        events.push({
          channel,
          externalId,
          senderId,
          mid: str(postback.mid) ?? `postback:${senderId}:${timestamp}`,
          timestamp,
          kind: 'postback',
          text: str(postback.title) ?? str(postback.payload),
          attachments: [],
          replyPayload: str(postback.payload),
          replyToMid: null,
          referral: parseReferral(postback.referral),
          unsupported: false,
        })
        continue
      }

      // A bare referral: the person opened the thread from an ad / m.me
      // link but hasn't written yet. Recorded for attribution only.
      const referral = parseReferral(ev.referral)
      if (referral) {
        events.push({
          channel,
          externalId,
          senderId,
          mid: `referral:${senderId}:${timestamp}`,
          timestamp,
          kind: 'referral',
          text: null,
          attachments: [],
          replyPayload: null,
          replyToMid: null,
          referral,
          unsupported: false,
        })
      }
    }
  }
  return events
}

/** Messaging-event fields worth naming in the diagnostic log line. */
const EVENT_TYPE_KEYS = [
  'message',
  'postback',
  'referral',
  'reaction',
  'read',
  'delivery',
  'optin',
  'pass_thread_control',
  'take_thread_control',
  'request_thread_control',
  'app_roles',
] as const

function eventTypes(list: unknown): string[] {
  if (!Array.isArray(list)) return []
  const counts = new Map<string, number>()
  for (const raw of list) {
    const ev = obj(raw)
    if (!ev) continue
    let type: string = EVENT_TYPE_KEYS.find((k) => ev[k] !== undefined) ?? 'other'
    if (type === 'message' && obj(ev.message)?.is_echo === true) type = 'message_echo'
    counts.set(type, (counts.get(type) ?? 0) + 1)
  }
  return [...counts].map(([k, n]) => (n > 1 ? `${k}x${n}` : k))
}

/**
 * One-line, content-free summary of a webhook body for the logs:
 * object, each entry.id and the event types it carries (messaging,
 * standby, changes + their fields). No text, no sender/recipient ids.
 */
export function summarizeSocialWebhook(body: unknown): string {
  const env = obj(body) as RawEnvelope | null
  if (!env) return 'invalid body'
  const object = typeof env.object === 'string' ? env.object : String(env.object)
  if (!Array.isArray(env.entry)) return `object=${object} entries=0`
  const parts = env.entry.map((entry) => {
    const e = obj(entry) ?? {}
    const id = typeof e.id === 'string' || typeof e.id === 'number' ? String(e.id) : '?'
    const groups: string[] = []
    if (Array.isArray(e.messaging)) groups.push(`messaging[${eventTypes(e.messaging).join(',')}]`)
    if (Array.isArray(e.standby)) groups.push(`standby[${eventTypes(e.standby).join(',')}]`)
    if (Array.isArray(e.changes)) {
      const fields = e.changes.map((c) => str(obj(c)?.field) ?? '?')
      groups.push(`changes[${fields.join(',')}]`)
    }
    return `${id}:${groups.length > 0 ? groups.join(' ') : 'empty'}`
  })
  return `object=${object} entries=${parts.length} ${parts.join(' | ')}`
}

/** Spanish preview label for an attachment-only message. */
export function attachmentPreview(type: string): string {
  switch (type) {
    case 'image':
      return '📷 Foto'
    case 'sticker':
      return '🙂 Sticker'
    case 'video':
    case 'ig_reel':
    case 'reel':
      return '🎥 Video'
    case 'audio':
      return '🎤 Audio'
    case 'file':
      return '📄 Archivo'
    case 'share':
    case 'ig_post':
      return '🔗 Publicación compartida'
    case 'story_mention':
      return '📣 Te mencionó en su historia'
    case 'location':
      return '📍 Ubicación'
    default:
      return '📎 Adjunto'
  }
}

/** messages.content_type for an attachment (CHECK-constraint-safe). */
export function contentTypeForAttachment(type: string): 'image' | 'video' | 'audio' | 'document' | 'text' {
  switch (type) {
    case 'image':
    case 'sticker':
      return 'image'
    case 'video':
    case 'ig_reel':
    case 'reel':
      return 'video'
    case 'audio':
      return 'audio'
    case 'file':
      return 'document'
    default:
      return 'text'
  }
}

// ============================================================
// Comments on the Page's posts/ads (object "page", field "feed") and on
// the Instagram account's media (object "instagram", fields "comments" /
// "live_comments"). They arrive in `entry[].changes[]`, not `messaging`:
//
//   page:      { field: 'feed', value: { item: 'comment', verb: 'add',
//                comment_id, post_id, parent_id, from: { id, name },
//                message, created_time } }
//   instagram: { field: 'comments', value: { id, text, parent_id?,
//                from: { id, username }, media: { id } } }
// ============================================================

export interface SocialCommentEvent {
  channel: SocialChannel
  /** entry.id — page id (Facebook) / IG account id (Instagram). */
  externalId: string
  commentId: string
  /** Post / ad (Facebook post_id, Instagram media.id). */
  postId: string | null
  /** Who commented (app-scoped id). */
  commenterId: string
  /** Comment time in ms (falls back to entry.time / now). */
  timestamp: number
  /** Instagram Live comment: Meta only allows the private reply. */
  live: boolean
}

function toMs(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  // Webhook `changes` use unix seconds; messaging uses ms.
  return value < 1e12 ? value * 1000 : value
}

/**
 * Normalize the new comments in one webhook body. Dropped: edits and
 * deletions (only verb "add"), the page's / account's own comments
 * (from.id === entry.id — our public replies would loop otherwise),
 * replies to other comments, and comments without an author id (we can't
 * tell they aren't ours).
 */
export function parseSocialComments(body: unknown): SocialCommentEvent[] {
  const env = obj(body) as RawEnvelope | null
  if (!env) return []
  const channel = channelForObject(env.object)
  if (!channel || !Array.isArray(env.entry)) return []

  const out: SocialCommentEvent[] = []
  for (const entry of env.entry) {
    const externalId = str(entry?.id)
    if (!externalId || !Array.isArray(entry.changes)) continue
    const entryTime = toMs(entry.time)

    for (const rawChange of entry.changes) {
      const change = obj(rawChange)
      const value = obj(change?.value)
      if (!change || !value) continue
      const field = str(change.field)
      const from = obj(value.from)
      const commenterId = str(from?.id)

      if (channel === 'messenger') {
        if (field !== 'feed' || value.item !== 'comment' || value.verb !== 'add') continue
        const commentId = str(value.comment_id)
        const postId = str(value.post_id)
        if (!commentId || !commenterId || commenterId === externalId) continue
        // A reply to another comment: parent_id is that comment, not the post.
        const parentId = str(value.parent_id)
        if (parentId && parentId !== postId) continue
        out.push({
          channel,
          externalId,
          commentId,
          postId,
          commenterId,
          timestamp: toMs(value.created_time) ?? entryTime ?? Date.now(),
          live: false,
        })
        continue
      }

      if (field !== 'comments' && field !== 'live_comments') continue
      const commentId = str(value.id)
      if (!commentId || !commenterId || commenterId === externalId) continue
      if (str(value.parent_id)) continue
      out.push({
        channel,
        externalId,
        commentId,
        postId: str(obj(value.media)?.id),
        commenterId,
        timestamp: entryTime ?? Date.now(),
        live: field === 'live_comments',
      })
    }
  }
  return out
}
