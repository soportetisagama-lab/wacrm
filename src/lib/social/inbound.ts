// ============================================================
// Inbound Instagram / Messenger processing — the social counterpart of
// processMessage() in app/api/whatsapp/webhook/route.ts.
//
// For each normalized event (lib/social/parse.ts):
//   1. resolve the account by (channel, entry.id) → social_channel_configs;
//   2. claim the Meta `mid` in social_inbound_events (Meta redelivers;
//      a second delivery of the same mid is dropped here);
//   3. find-or-create the contact (keyed by IGSID/PSID, no phone) and
//      its conversation;
//   4. store the ad referral, the message and our copy of any media;
//   5. run the same bot pipeline as WhatsApp: acknowledgement, Flows,
//      automations, AI auto-reply. Menus go out as quick replies /
//      numbered text (lib/social/send.ts); a typed number or title is
//      mapped back to the option id here, so Flows route it as a tap;
//   6. if this was the contact's first message and nothing at all
//      answered it (a flow step that only works on WhatsApp, a failed
//      send…), ask for the celular (or, with it on file, thank them and
//      flag the chat) instead of leaving it silent.
// Before any handoff the bot asks for the celular (lib/ai/awaiting-phone)
// and never promises an advisor: the Community Manager serves these chats
// first. A typed number is kept in contacts.contact_phone (migration 086).
// ============================================================

import { randomUUID } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'

import { supabaseAdmin } from '@/lib/flows/admin-client'
import { decrypt } from '@/lib/whatsapp/encryption'
import { isUniqueViolation } from '@/lib/contacts/dedupe'
import { reopenClosedConversation } from '@/lib/conversations/reopen'
import { routeAcknowledgement } from '@/lib/conversations/acknowledgement'
import { dispatchInboundToFlows } from '@/lib/flows/engine'
import { engineSendText } from '@/lib/flows/meta-send'
import { runAutomationsForTrigger } from '@/lib/automations/engine'
import { completeHandoffAwaitingPhone, dispatchInboundToAiReply } from '@/lib/ai/auto-reply'
import {
  askPhoneBeforeHandoff,
  loadContactPhoneState,
  loadHandoffSummary,
  parseAwaitingPhone,
  socialClosingTextFor,
  swapHeldMarker,
} from '@/lib/ai/awaiting-phone'
import { restartWelcomeAfterPhoneKnown } from '@/lib/flows/welcome'
import { extractTypedPhone } from '@/lib/whatsapp/phone-utils'
import { dispatchWebhookEvent } from '@/lib/webhooks/deliver'
import { sendPushToUser } from '@/lib/notifications/push-send'
import { storeInboundMediaCopy } from '@/lib/whatsapp/inbound-media'
import type { InteractiveMessagePayload } from '@/lib/whatsapp/interactive'
import { CHANNEL_LABEL, canViewChannel, type SocialChannel } from '@/lib/channels/types'
import { fetchSocialProfile } from './graph'
import { matchNumberedReply } from './interactive'
import {
  attachmentPreview,
  contentTypeForAttachment,
  parseSocialWebhook,
  type SocialAttachment,
  type SocialInboundEvent,
} from './parse'
import type { SocialConfigRow } from './send'
import { noteInboundControl } from './thread-control'
import { processSocialCommentsBody } from './comments'

/** Sent when nothing answered a contact's first message and their number
 *  is already on file (see step 6). The Community Manager serves these
 *  chats first: no advisor is promised. Without a number the bot asks for
 *  it instead (ASK_PHONE_TEXT) and holds the handoff. */
export const SOCIAL_FALLBACK_HANDOFF_TEXT =
  '¡Gracias por escribirnos! Ya registramos tu consulta y te contactamos pronto.'

/** Media bigger than this is linked, not copied (keeps the webhook fast). */
const MAX_MEDIA_COPY_BYTES = 25 * 1024 * 1024

export async function processSocialWebhookBody(body: unknown): Promise<void> {
  const events = parseSocialWebhook(body)
  for (const event of events) {
    try {
      await processSocialEvent(supabaseAdmin(), event)
    } catch (err) {
      console.error(`[social webhook] ${event.channel} event ${event.mid} failed:`, err)
    }
  }
  // Comments on posts/ads (entry.changes): public + private auto-reply.
  await processSocialCommentsBody(body)
}

/** Claim a Meta mid. False when it was already processed (duplicate delivery). */
export async function claimInboundEvent(
  db: SupabaseClient,
  channel: SocialChannel,
  mid: string,
  accountId: string,
): Promise<boolean> {
  const { error } = await db
    .from('social_inbound_events')
    .insert({ channel, mid, account_id: accountId })
  if (!error) return true
  if (isUniqueViolation(error)) return false
  // Can't tell whether it's a duplicate: drop it rather than risk storing
  // (and answering) the same message twice. Logged loudly so it's visible.
  console.error(`[social webhook] dedupe claim failed — ${channel} event ${mid} discarded:`, error.message)
  return false
}

async function releaseInboundEvent(db: SupabaseClient, channel: SocialChannel, mid: string) {
  await db.from('social_inbound_events').delete().eq('channel', channel).eq('mid', mid)
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = any

async function findOrCreateSocialContact(
  db: SupabaseClient,
  config: SocialConfigRow,
  event: SocialInboundEvent,
): Promise<{ contact: Row; wasCreated: boolean } | null> {
  const lookup = () =>
    db
      .from('contacts')
      .select('*')
      .eq('account_id', config.account_id)
      .eq('channel', event.channel)
      .eq('channel_user_id', event.senderId)
      .maybeSingle()

  const { data: existing } = await lookup()
  if (existing) return { contact: existing, wasCreated: false }

  let profile = null
  try {
    profile = await fetchSocialProfile({
      channel: event.channel,
      userId: event.senderId,
      accessToken: decrypt(config.access_token),
    })
  } catch {
    profile = null
  }
  const label = CHANNEL_LABEL[event.channel]
  const name =
    profile?.name || (profile?.username ? `@${profile.username}` : null) || `Usuario de ${label}`

  const { data: created, error } = await db
    .from('contacts')
    .insert({
      account_id: config.account_id,
      user_id: config.user_id,
      phone: null,
      channel: event.channel,
      channel_user_id: event.senderId,
      channel_username: profile?.username ?? null,
      name,
    })
    .select()
    .single()

  if (error) {
    if (isUniqueViolation(error)) {
      const { data: raced } = await lookup()
      if (raced) return { contact: raced, wasCreated: false }
    }
    console.error('[social webhook] contact create failed:', error)
    return null
  }
  return { contact: created, wasCreated: true }
}

async function findOrCreateSocialConversation(
  db: SupabaseClient,
  config: SocialConfigRow,
  contactId: string,
  channel: SocialChannel,
): Promise<{ conversation: Row; created: boolean } | null> {
  const lookup = () =>
    db
      .from('conversations')
      .select('*')
      .eq('account_id', config.account_id)
      .eq('contact_id', contactId)
      .order('created_at', { ascending: true })
      .limit(1)

  const { data: rows, error } = await lookup()
  if (error) {
    console.error('[social webhook] conversation lookup failed:', error)
    return null
  }
  if (rows && rows.length > 0) return { conversation: rows[0], created: false }

  const { data: created, error: createErr } = await db
    .from('conversations')
    .insert({
      account_id: config.account_id,
      user_id: config.user_id,
      contact_id: contactId,
      channel,
    })
    .select()
    .single()
  if (createErr) {
    if (isUniqueViolation(createErr)) {
      const { data: raced } = await lookup()
      if (raced && raced.length > 0) return { conversation: raced[0], created: false }
    }
    console.error('[social webhook] conversation create failed:', createErr)
    return null
  }
  return { conversation: created, created: true }
}

async function saveSocialReferral(
  db: SupabaseClient,
  event: SocialInboundEvent,
  accountId: string,
  conversationId: string,
  contactId: string,
) {
  const r = event.referral
  if (!r) return
  const { error } = await db.from('conversation_referrals').insert({
    account_id: accountId,
    conversation_id: conversationId,
    contact_id: contactId,
    channel: event.channel,
    source_id: r.ad_id,
    source_url: r.source_url,
    headline: r.headline,
    body: null,
    media_type: r.video_url ? 'video' : r.image_url ? 'image' : null,
    image_url: r.image_url,
    video_url: r.video_url,
    ref: r.ref,
    raw: r.raw,
    created_at: new Date(event.timestamp).toISOString(),
  })
  if (error) console.error('[social webhook] referral insert failed:', error.message)
}

/** The newest bot/agent interactive menu in the conversation, for numbered replies. */
async function lastSentMenu(
  db: SupabaseClient,
  conversationId: string,
): Promise<InteractiveMessagePayload | null> {
  const { data } = await db
    .from('messages')
    .select('sender_type, content_type, interactive_payload')
    .eq('conversation_id', conversationId)
    .neq('sender_type', 'customer')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  const row = data as { content_type?: string; interactive_payload?: InteractiveMessagePayload | null } | null
  if (row?.content_type !== 'interactive' || !row.interactive_payload) return null
  return row.interactive_payload
}

async function copyAttachment(
  db: SupabaseClient,
  accountId: string,
  messageDbId: string,
  attachment: SocialAttachment,
): Promise<boolean> {
  if (!attachment.url) return false
  try {
    const res = await fetch(attachment.url)
    if (!res.ok) return false
    const declared = Number(res.headers.get('content-length') ?? '0')
    if (declared > MAX_MEDIA_COPY_BYTES) return false
    const buffer = Buffer.from(await res.arrayBuffer())
    if (buffer.byteLength > MAX_MEDIA_COPY_BYTES) return false
    const mimeType = res.headers.get('content-type') ?? 'application/octet-stream'
    const stored = await storeInboundMediaCopy(db, {
      accountId,
      messageDbId,
      buffer,
      mimeType,
      filename: null,
      isPhoto: attachment.type === 'image',
    })
    return stored !== null
  } catch (err) {
    console.warn('[social webhook] media copy failed:', err instanceof Error ? err.message : err)
    return false
  }
}

/** Push to the assignee only if they can actually see this channel's chats. */
async function pushIfVisible(
  db: SupabaseClient,
  config: SocialConfigRow,
  conversation: Row,
  title: string,
  body: string,
) {
  const assignee: string | null = conversation.assigned_agent_id ?? null
  if (!assignee) return
  const { data: profile } = await db
    .from('profiles')
    .select('account_role')
    .eq('user_id', assignee)
    .maybeSingle()
  const role = (profile as { account_role?: string } | null)?.account_role ?? ''
  if (!canViewChannel({ channel: config.channel, role, showToAgents: config.show_to_agents })) return
  sendPushToUser(assignee, { title, body, data: { conversationId: conversation.id } }).catch((err) =>
    console.error('[social webhook] push failed:', err),
  )
}

export async function processSocialEvent(db: SupabaseClient, event: SocialInboundEvent): Promise<void> {
  const { data: configRow, error: configErr } = await db
    .from('social_channel_configs')
    .select('*')
    .eq('channel', event.channel)
    .eq('external_id', event.externalId)
    .maybeSingle()
  if (configErr) {
    console.error('[social webhook] config lookup failed:', configErr.message)
    return
  }
  const config = configRow as SocialConfigRow | null
  if (!config) {
    console.warn(`[social webhook] no ${event.channel} config for entry ${event.externalId}`)
    return
  }
  if (!config.enabled) return
  const accountId = config.account_id

  // Dedupe by mid also covers a message Meta delivers both as
  // `messaging` and as `standby`.
  if (!(await claimInboundEvent(db, event.channel, event.mid, accountId))) return
  if (event.kind === 'message') {
    noteInboundControl(event.channel, event.senderId, event.standby === true)
    if (event.standby) {
      console.log(`[social webhook] ${event.channel} message arrived as standby (another app controls the thread)`)
    }
  }

  const contactOutcome = await findOrCreateSocialContact(db, config, event)
  if (!contactOutcome) {
    await releaseInboundEvent(db, event.channel, event.mid)
    return
  }
  const contact = contactOutcome.contact
  const convResult = await findOrCreateSocialConversation(db, config, contact.id, event.channel)
  if (!convResult) {
    await releaseInboundEvent(db, event.channel, event.mid)
    return
  }
  const conversation = convResult.conversation

  if (convResult.created) {
    await dispatchWebhookEvent(db, accountId, 'conversation.created', {
      conversation_id: conversation.id,
      contact_id: contact.id,
      channel: event.channel,
    })
  }

  await saveSocialReferral(db, event, accountId, conversation.id, contact.id)
  // Opened the chat from an ad but hasn't written yet: attribution only.
  if (event.kind === 'referral') return

  // ---- What the customer said --------------------------------------
  let interactiveReplyId: string | null = event.replyPayload
  let interactiveTitle: string | null = null
  if (!interactiveReplyId && event.text && event.attachments.length === 0) {
    const menu = await lastSentMenu(db, conversation.id)
    const match = menu ? matchNumberedReply(event.text, menu) : null
    if (match) {
      interactiveReplyId = match.id
      interactiveTitle = match.title
    }
  }

  const firstAttachment = event.attachments[0] ?? null
  const attachmentContentType = firstAttachment ? contentTypeForAttachment(firstAttachment.type) : null
  const isMedia = attachmentContentType !== null && attachmentContentType !== 'text'
  const contentType = interactiveReplyId ? 'interactive' : isMedia ? attachmentContentType : 'text'
  const contentText =
    interactiveTitle ??
    event.text ??
    (event.unsupported
      ? `⚠️ El cliente envió un contenido que ${CHANNEL_LABEL[event.channel]} no permite ver aquí. Pídele que lo reenvíe.`
      : null) ??
    (firstAttachment && !isMedia
      ? [attachmentPreview(firstAttachment.type), firstAttachment.url].filter(Boolean).join('\n')
      : null)

  const { count: priorCustomerMsgCount } = await db
    .from('messages')
    .select('id', { count: 'exact', head: true })
    .eq('conversation_id', conversation.id)
    .eq('sender_type', 'customer')
  const isFirstInboundMessage = (priorCustomerMsgCount ?? 0) === 0

  let replyToInternalId: string | null = null
  if (event.replyToMid) {
    const { data: parent } = await db
      .from('messages')
      .select('id')
      .eq('conversation_id', conversation.id)
      .eq('message_id', event.replyToMid)
      .limit(1)
      .maybeSingle()
    replyToInternalId = (parent as { id?: string } | null)?.id ?? null
  }

  const createdAt = new Date(event.timestamp).toISOString()
  const proxyMediaUrl = isMedia ? `/api/whatsapp/media/sm_${randomUUID()}` : null
  const { data: inserted, error: msgErr } = await db
    .from('messages')
    .insert({
      conversation_id: conversation.id,
      sender_type: 'customer',
      content_type: contentType,
      content_text: contentText,
      media_url: proxyMediaUrl,
      message_id: event.mid,
      status: 'delivered',
      created_at: createdAt,
      reply_to_message_id: replyToInternalId,
      interactive_reply_id: interactiveReplyId,
      is_sticker: firstAttachment?.type === 'sticker',
    })
    .select('id')
    .single()
  if (msgErr || !inserted) {
    console.error('[social webhook] message insert failed:', msgErr)
    await releaseInboundEvent(db, event.channel, event.mid)
    return
  }

  // Our own copy of the media (Meta's CDN links expire). If the copy
  // fails, point the bubble straight at Meta's link — works for a while.
  if (isMedia && firstAttachment) {
    const copied = await copyAttachment(db, accountId, inserted.id, firstAttachment)
    if (!copied && firstAttachment.url) {
      await db.from('messages').update({ media_url: firstAttachment.url }).eq('id', inserted.id)
    }
  }
  // Extra attachments in the same message: one bubble each.
  for (let i = 1; i < event.attachments.length; i++) {
    const att = event.attachments[i]
    const type = contentTypeForAttachment(att.type)
    const { data: extra } = await db
      .from('messages')
      .insert({
        conversation_id: conversation.id,
        sender_type: 'customer',
        content_type: type,
        content_text: type === 'text' ? [attachmentPreview(att.type), att.url].filter(Boolean).join('\n') : null,
        media_url: type === 'text' ? null : `/api/whatsapp/media/sm_${randomUUID()}`,
        message_id: `${event.mid}#${i + 1}`,
        status: 'delivered',
        created_at: createdAt,
      })
      .select('id')
      .single()
    if (extra && type !== 'text') {
      const copied = await copyAttachment(db, accountId, extra.id, att)
      if (!copied && att.url) await db.from('messages').update({ media_url: att.url }).eq('id', extra.id)
    }
  }

  const preview = contentText || (firstAttachment ? attachmentPreview(firstAttachment.type) : `[${contentType}]`)
  await db
    .from('conversations')
    .update({
      last_message_text: preview,
      last_message_at: new Date().toISOString(),
      unread_count: (conversation.unread_count || 0) + 1,
      updated_at: new Date().toISOString(),
    })
    .eq('id', conversation.id)
  await reopenClosedConversation(db, conversation)

  await pushIfVisible(
    db,
    config,
    conversation,
    contact.name || CHANNEL_LABEL[event.channel],
    contentType === 'text' && contentText ? contentText : attachmentPreview(firstAttachment?.type ?? ''),
  )

  const emitMessageReceived = () =>
    dispatchWebhookEvent(db, accountId, 'message.received', {
      conversation_id: conversation.id,
      contact_id: contact.id,
      whatsapp_message_id: event.mid,
      content_type: contentType,
      text: contentText,
      channel: event.channel,
    })

  // ---- The number, typed (no share button on these networks) ----------
  // Stored in contacts.contact_phone (migration 086), never in `phone`
  // (081: a phone there would merge the person's WhatsApp chats into this
  // one). Then, as on WhatsApp (webhook phoneJustKnown):
  //   - a handoff on hold for it goes through now (closing + 📋 brief);
  //   - the first-message hold (options.welcome), or no flow running and
  //     no AI reply yet: the welcome restarts at its phone gate, which now
  //     finds the number and follows the flow's own Peru / foreign branch;
  //   - the AI already talking (no hold, no flow): saved, the AI goes on;
  // and nothing else answers this message.
  let handoffDoneFromPhone = false
  const typedPhone =
    event.kind === 'message' && !interactiveReplyId && event.text && 'contact_phone' in contact && !contact.contact_phone
      ? extractTypedPhone(event.text)
      : null
  if (typedPhone) {
    const { error: phoneErr } = await db
      .from('contacts')
      .update({ contact_phone: typedPhone, updated_at: new Date().toISOString() })
      .eq('id', contact.id)
    if (phoneErr) {
      console.error('[social webhook] saving the typed phone failed:', phoneErr.message)
    } else {
      const marker = await loadHandoffSummary(db, conversation.id)
      const held = parseAwaitingPhone(marker)
      if (held && marker && !held.options.welcome) {
        handoffDoneFromPhone = await completeHandoffAwaitingPhone({
          accountId,
          conversationId: conversation.id,
          contactId: contact.id,
          configOwnerUserId: config.user_id,
        })
      } else if (held && marker) {
        // Only whoever clears the first-message hold restarts the welcome.
        if (await swapHeldMarker(db, conversation.id, marker, null)) {
          handoffDoneFromPhone = await restartWelcomeAfterPhoneKnown(accountId, contact.id, conversation.id, {
            reason: 'social_phone_typed',
          })
        } else {
          handoffDoneFromPhone = true
        }
      } else if (
        !(await hasActiveFlowRun(db, accountId, contact.id)) &&
        !(await aiAlreadyConversing(db, conversation.id))
      ) {
        // Still waiting for the first exchange: restart the welcome. If the
        // AI was already talking, the number is just saved and the AI goes on.
        handoffDoneFromPhone = await restartWelcomeAfterPhoneKnown(accountId, contact.id, conversation.id, {
          reason: 'social_phone_typed',
        })
      }
    }
  }

  if (handoffDoneFromPhone) {
    await emitMessageReceived()
    return
  }

  // ---- Bot pipeline (same order as the WhatsApp webhook) ---------------
  const inboundText = contentText ?? ''
  const isSticker = firstAttachment?.type === 'sticker'
  const isImage = firstAttachment?.type === 'image'

  const acknowledged =
    !interactiveReplyId && !isImage
      ? await routeAcknowledgement({
          db,
          accountId,
          userId: config.user_id,
          conversationId: conversation.id,
          contactId: contact.id,
          text: inboundText,
          isSticker,
        })
      : null

  const flowResult = acknowledged
    ? { consumed: true as const }
    : await dispatchInboundToFlows({
        accountId,
        userId: config.user_id,
        contactId: contact.id,
        conversationId: conversation.id,
        message: interactiveReplyId
          ? {
              kind: 'interactive_reply',
              reply_id: interactiveReplyId,
              reply_title: inboundText,
              meta_message_id: event.mid,
            }
          : {
              kind: 'text',
              text: inboundText,
              meta_message_id: event.mid,
              isImageMessage: isImage,
            },
        isFirstInboundMessage,
      })
  const flowConsumed = flowResult.consumed
  const answerAfterWelcome = 'answer_with_ai' in flowResult && flowResult.answer_with_ai === true

  const triggers: (
    | 'new_contact_created'
    | 'first_inbound_message'
    | 'new_message_received'
    | 'keyword_match'
    | 'interactive_reply'
  )[] = []
  if (!flowConsumed) {
    triggers.push('new_message_received', 'keyword_match')
    if (interactiveReplyId) triggers.push('interactive_reply')
  }
  if (contactOutcome.wasCreated) triggers.unshift('new_contact_created')
  if (isFirstInboundMessage) triggers.unshift('first_inbound_message')
  for (const triggerType of triggers) {
    await runAutomationsForTrigger({
      accountId,
      triggerType,
      contactId: contact.id,
      context: {
        message_text: inboundText,
        conversation_id: conversation.id,
        interactive_reply_id: interactiveReplyId ?? undefined,
      },
    }).catch((err) => console.error('[social webhook] automations failed:', err))
  }

  if ((!flowConsumed || answerAfterWelcome) && (isMedia || inboundText.trim())) {
    await dispatchInboundToAiReply({
      accountId,
      conversationId: conversation.id,
      contactId: contact.id,
      configOwnerUserId: config.user_id,
      isTextMessage: !isMedia,
      // No voice-note transcription on these channels (it reads WhatsApp media ids).
      audio: undefined,
      isImageMessage: isImage,
    })
  }

  if (isFirstInboundMessage) {
    await handOffIfUnanswered(db, config, conversation.id, contact.id, createdAt)
  }

  await emitMessageReceived()
}

/**
 * Step 6: the contact's first message got no answer from Flows,
 * automations or the AI (e.g. a flow branch that only makes sense on
 * WhatsApp, or a send that failed). Rather than leave a new lead in
 * silence: without their number on file, ask for it and hold the handoff
 * (lib/ai/awaiting-phone — completed when they type it); with it, thank
 * them and flag the chat for the team. No advisor is promised either way:
 * the Community Manager serves these chats first.
 */
export async function handOffIfUnanswered(
  db: SupabaseClient,
  config: SocialConfigRow,
  conversationId: string,
  contactId: string,
  inboundCreatedAt: string,
): Promise<boolean> {
  const { count } = await db
    .from('messages')
    .select('id', { count: 'exact', head: true })
    .eq('conversation_id', conversationId)
    .in('sender_type', ['bot', 'agent'])
    .gte('created_at', inboundCreatedAt)
  if ((count ?? 0) > 0) return false

  const { data: conv } = await db
    .from('conversations')
    .select('assigned_agent_id, unread_count')
    .eq('id', conversationId)
    .maybeSingle()
  if ((conv as { assigned_agent_id?: string | null } | null)?.assigned_agent_id) return false

  const summary = `El bot no pudo atender este chat de ${CHANNEL_LABEL[config.channel]}. Atiéndelo un asesor.`
  const phoneState = await loadContactPhoneState(db, contactId)
  if (phoneState?.needsPhone) {
    // Usually the welcome stopped at its phone gate (as on WhatsApp, where
    // the share-number button asks): ask here and restart the welcome once
    // the number arrives (options.welcome).
    const held = await askPhoneBeforeHandoff(db, {
      accountId: config.account_id,
      conversationId,
      contactId,
      userId: config.user_id,
      summary,
      options: { welcome: true },
    })
    if (held !== 'give_up') return true
  }

  try {
    await engineSendText({
      accountId: config.account_id,
      userId: config.user_id,
      conversationId,
      contactId,
      text: phoneState?.socialPhone ? socialClosingTextFor(phoneState) : SOCIAL_FALLBACK_HANDOFF_TEXT,
    })
  } catch (err) {
    console.error('[social webhook] fallback handoff text failed:', err)
  }
  await db
    .from('conversations')
    .update({
      status: 'pending',
      ai_autoreply_disabled: true,
      ai_handoff_summary: summary,
      updated_at: new Date().toISOString(),
    })
    .eq('id', conversationId)
  return true
}

/** True when the AI already answered in this conversation (then a typed
 *  number is saved and the AI goes on; no welcome restart). */
async function aiAlreadyConversing(db: SupabaseClient, conversationId: string): Promise<boolean> {
  const { data, error } = await db
    .from('conversations')
    .select('ai_reply_count')
    .eq('id', conversationId)
    .maybeSingle()
  // Unknown: don't restart anything.
  if (error) return true
  return Number((data as { ai_reply_count?: number | null } | null)?.ai_reply_count ?? 0) > 0
}

/** True when a flow run is still active for this contact (then a typed
 *  number is just part of that conversation, not a welcome restart). */
async function hasActiveFlowRun(db: SupabaseClient, accountId: string, contactId: string): Promise<boolean> {
  const { data, error } = await db
    .from('flow_runs')
    .select('id')
    .eq('account_id', accountId)
    .eq('contact_id', contactId)
    .eq('status', 'active')
    .limit(1)
  // Unknown: don't restart anything.
  if (error) return true
  return Array.isArray(data) && data.length > 0
}
