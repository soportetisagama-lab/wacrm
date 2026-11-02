// ============================================================
// TikTok webhook payloads → the same normalized inbound events Instagram
// and Messenger produce (lib/social/parse.ts), so the shared pipeline
// (lib/social/inbound.ts: contact, conversation, message, Flows,
// automations, AI) handles TikTok DMs unchanged.
//
// Pure (no I/O) so it's unit-testable.
//
// TODO verificar con docs cuando la app esté aprobada: forma exacta del
// evento. Se asume el sobre de los webhooks de TikTok:
//   { event, create_time, user_openid, content }
// donde `user_openid` es la cuenta Business que recibe y `content` (objeto
// o JSON en texto) trae { conversation_id, message_id, timestamp, type,
// text: { body }, image: { url }, from_user: { id, role } }.
// ============================================================

import type { SocialInboundEvent } from '@/lib/social/parse'
import { TIKTOK_INBOUND_MESSAGE_EVENTS } from './api'

type Obj = Record<string, unknown>

function obj(value: unknown): Obj | null {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Obj
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value) as unknown
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Obj) : null
    } catch {
      return null
    }
  }
  return null
}

function str(value: unknown): string | null {
  if (typeof value === 'string' && value.trim()) return value
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return null
}

/** Unix seconds or milliseconds → milliseconds. */
function toMs(value: unknown, fallback: number): number {
  const n = typeof value === 'string' ? Number(value) : typeof value === 'number' ? value : NaN
  if (!Number.isFinite(n) || n <= 0) return fallback
  return n < 1e12 ? n * 1000 : n
}

/** One TikTok webhook delivery → zero or one inbound DM event. */
export function parseTikTokWebhook(body: unknown, nowMs: number = Date.now()): SocialInboundEvent[] {
  const envelope = obj(body)
  if (!envelope) return []
  const eventName = str(envelope.event)
  if (!eventName || !TIKTOK_INBOUND_MESSAGE_EVENTS.includes(eventName)) return []

  const businessId = str(envelope.user_openid) ?? str(envelope.business_id)
  const content = obj(envelope.content)
  if (!businessId || !content) return []

  // Our own messages echoed back: never stored as the customer's.
  const fromUser = obj(content.from_user)
  const fromId = str(fromUser?.id) ?? str(content.from)
  const fromRole = str(fromUser?.role)
  if ((fromId && fromId === businessId) || (fromRole && /business/i.test(fromRole))) return []

  // The reply is addressed by conversation (TIKTOK_RECIPIENT_TYPE), so the
  // conversation id is the person's key; the sender id is the fallback.
  const senderKey = str(content.conversation_id) ?? fromId
  const mid = str(content.message_id)
  if (!senderKey || !mid) return []

  const type = (str(content.type) ?? (content.text ? 'text' : 'unknown')).toLowerCase()
  const textObj = obj(content.text)
  const text = str(textObj?.body) ?? (typeof content.text === 'string' ? str(content.text) : null)
  const attachments: SocialInboundEvent['attachments'] = []
  if (type !== 'text') {
    const media = obj(content[type])
    const url = str(media?.url) ?? str(media?.media_url)
    if (url) attachments.push({ type: type === 'image' ? 'image' : type === 'video' ? 'video' : 'file', url })
  }

  return [
    {
      channel: 'tiktok',
      externalId: businessId,
      senderId: senderKey,
      mid,
      timestamp: toMs(content.timestamp ?? envelope.create_time, nowMs),
      kind: 'message',
      text: type === 'text' ? text : null,
      attachments,
      replyPayload: null,
      replyToMid: null,
      referral: null,
      unsupported: type !== 'text' && attachments.length === 0,
    },
  ]
}

/** Log line for a delivery: event and type only (no content, no ids). */
export function summarizeTikTokWebhook(body: unknown): string {
  const envelope = obj(body)
  const content = obj(envelope?.content)
  return `event=${str(envelope?.event) ?? '-'} type=${str(content?.type) ?? '-'}`
}
