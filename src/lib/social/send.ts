// ============================================================
// Outbound send for Instagram / Messenger conversations.
//
// Every send path in the CRM (inbox composer, public API, Flows,
// automations, AI auto-reply) checks the contact's channel first and,
// for a social contact, comes here instead of the WhatsApp Cloud API.
// The callers keep doing their own persistence (messages row,
// conversation preview), exactly as for WhatsApp — this only talks to
// Meta and returns the message id.
//
// Meta's 24 h rule is enforced here, before calling Meta: outside the
// window the send is refused with code 'window_closed', which the inbox
// shows as "no se puede enviar". (Meta would reject it anyway.)
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'

import { supabaseAdmin } from '@/lib/flows/admin-client'
import { decrypt } from '@/lib/whatsapp/encryption'
import type { InteractiveMessagePayload } from '@/lib/whatsapp/interactive'
import {
  CHANNEL_LABEL,
  channelOf,
  isSocialChannel,
  isWithinMessagingWindow,
  type SocialChannel,
} from '@/lib/channels/types'
import {
  GraphApiError,
  SOCIAL_TEXT_LIMIT,
  isOutsideWindowError,
  isThreadControlError,
  sendSocialAttachment,
  sendSocialText,
  splitForChannel,
  takeThreadControl,
  type SocialAttachmentType,
  type SocialSendTarget,
} from './graph'
import { toSocialMenu } from './interactive'
import { clearStandby, lastInboundWasStandby } from './thread-control'

async function tryTakeThreadControl(channel: SocialChannel, target: SocialSendTarget, reason: string): Promise<boolean> {
  try {
    await takeThreadControl(target)
    clearStandby(channel, target.recipientId)
    console.log(`[social] ${channel}: took thread control (${reason})`)
    return true
  } catch (err) {
    const e = err instanceof GraphApiError ? err : null
    console.warn(
      `[social] ${channel}: take_thread_control failed (${reason}) code=${e?.code ?? '-'} subcode=${e?.subcode ?? '-'}:`,
      err instanceof Error ? err.message : err,
    )
    return false
  }
}

/**
 * Run one Send API call; if Meta refuses it because another app controls
 * the thread, take thread control and retry that call once.
 */
async function withThreadControl<T>(
  channel: SocialChannel,
  target: SocialSendTarget,
  send: () => Promise<T>,
): Promise<T> {
  try {
    return await send()
  } catch (err) {
    if (!isThreadControlError(err)) throw err
    if (!(await tryTakeThreadControl(channel, target, 'send refused'))) throw err
    return send()
  }
}

export type SocialSendErrorCode =
  | 'not_configured'
  | 'window_closed'
  | 'unsupported'
  | 'no_recipient'
  | 'meta_error'

export class SocialSendError extends Error {
  readonly code: SocialSendErrorCode
  readonly status: number
  constructor(code: SocialSendErrorCode, message: string, status: number) {
    super(message)
    this.name = 'SocialSendError'
    this.code = code
    this.status = status
  }
}

export interface SocialConfigRow {
  id: string
  account_id: string
  user_id: string
  channel: SocialChannel
  external_id: string
  page_id: string
  access_token: string
  display_name: string | null
  username: string | null
  enabled: boolean
  show_to_agents: boolean
}

/** The account's config for one channel (service role — the table is admin-only under RLS). */
export async function loadSocialConfig(
  accountId: string,
  channel: SocialChannel,
): Promise<SocialConfigRow | null> {
  const { data, error } = await supabaseAdmin()
    .from('social_channel_configs')
    .select('*')
    .eq('account_id', accountId)
    .eq('channel', channel)
    .maybeSingle()
  if (error) {
    console.error('[social] config lookup failed:', error.message)
    return null
  }
  return (data as SocialConfigRow | null) ?? null
}

/** created_at of the newest customer message in a conversation, or null. */
export async function lastCustomerMessageAt(
  db: SupabaseClient,
  conversationId: string,
): Promise<string | null> {
  const { data } = await db
    .from('messages')
    .select('created_at')
    .eq('conversation_id', conversationId)
    .eq('sender_type', 'customer')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  return (data as { created_at?: string } | null)?.created_at ?? null
}

export type SocialOutbound =
  | { kind: 'text'; text: string }
  | {
      kind: 'media'
      mediaKind: 'image' | 'video' | 'audio' | 'document'
      url: string
      caption?: string | null
    }
  | { kind: 'interactive'; payload: InteractiveMessagePayload }

export interface SocialContactLike {
  channel?: string | null
  channel_user_id?: string | null
}

/** True when this contact must be reached through Instagram/Messenger. */
export function isSocialContact(contact: SocialContactLike | null | undefined): boolean {
  return isSocialChannel(channelOf(contact))
}

function attachmentTypeFor(
  channel: SocialChannel,
  mediaKind: 'image' | 'video' | 'audio' | 'document',
): SocialAttachmentType {
  if (mediaKind === 'document') {
    if (channel === 'instagram') {
      throw new SocialSendError(
        'unsupported',
        'Instagram no permite enviar documentos. Envía una imagen o un enlace.',
        400,
      )
    }
    return 'file'
  }
  return mediaKind
}

/**
 * Send one outbound message to a social contact. Returns Meta's message
 * id (the last one when the text had to be split). Throws SocialSendError.
 *
 * `db` is only used for the 24 h window lookup, so either an RLS-scoped
 * user client or the service role works.
 */
export async function sendSocialOutbound(
  db: SupabaseClient,
  args: {
    accountId: string
    conversationId: string
    contact: SocialContactLike
    outbound: SocialOutbound
    /** Skip the window check (only for tests / callers that just checked it). */
    skipWindowCheck?: boolean
  },
): Promise<{ messageId: string }> {
  const channel = channelOf(args.contact)
  if (!isSocialChannel(channel)) {
    throw new SocialSendError('unsupported', 'Este contacto no es de Instagram ni Messenger.', 400)
  }
  const label = CHANNEL_LABEL[channel]
  const recipientId = args.contact.channel_user_id
  if (!recipientId) {
    throw new SocialSendError('no_recipient', `El contacto no tiene un id de ${label}.`, 400)
  }

  const config = await loadSocialConfig(args.accountId, channel)
  if (!config || !config.enabled) {
    throw new SocialSendError(
      'not_configured',
      `${label} no está conectado. Un administrador debe configurarlo en Configuración.`,
      400,
    )
  }

  if (!args.skipWindowCheck) {
    const last = await lastCustomerMessageAt(db, args.conversationId)
    if (!isWithinMessagingWindow(last)) {
      throw new SocialSendError(
        'window_closed',
        `Pasaron más de 24 horas desde el último mensaje del cliente. ${label} no permite responder hasta que vuelva a escribir.`,
        400,
      )
    }
  }

  let accessToken: string
  try {
    accessToken = decrypt(config.access_token)
  } catch {
    throw new SocialSendError(
      'not_configured',
      `No se pudo leer el token de ${label}. Vuelve a guardarlo en Configuración.`,
      500,
    )
  }
  const target = { accessToken, recipientId }
  const limit = SOCIAL_TEXT_LIMIT[channel]
  // The customer's last message came as standby: another app owns the
  // thread, so take it before sending (a failure here is retried below).
  if (lastInboundWasStandby(channel, recipientId)) {
    await tryTakeThreadControl(channel, target, 'last inbound was standby')
  }
  const sendText = (a: Omit<Parameters<typeof sendSocialText>[0], keyof SocialSendTarget>) =>
    withThreadControl(channel, target, () => sendSocialText({ ...target, ...a }))
  const sendAttachment = (a: Omit<Parameters<typeof sendSocialAttachment>[0], keyof SocialSendTarget>) =>
    withThreadControl(channel, target, () => sendSocialAttachment({ ...target, ...a }))

  try {
    const out = args.outbound
    if (out.kind === 'text') {
      const parts = splitForChannel(out.text, limit)
      if (parts.length === 0) throw new SocialSendError('unsupported', 'El mensaje está vacío.', 400)
      let messageId = ''
      for (const part of parts) messageId = await sendText({ text: part })
      return { messageId }
    }

    if (out.kind === 'media') {
      const type = attachmentTypeFor(channel, out.mediaKind)
      let messageId = await sendAttachment({ type, url: out.url })
      // Neither network takes a caption on an attachment: it goes as its own text.
      const caption = out.caption?.trim()
      if (caption) {
        for (const part of splitForChannel(caption, limit)) {
          messageId = await sendText({ text: part })
        }
      }
      return { messageId }
    }

    const menu = toSocialMenu(out.payload)
    if (menu.mode === 'quick_replies') {
      const parts = splitForChannel(menu.text, limit)
      let messageId = ''
      // Quick replies ride on the LAST chunk, so the chips stay under the text.
      for (let i = 0; i < parts.length; i++) {
        const isLast = i === parts.length - 1
        messageId = await sendText({
          text: parts[i],
          quickReplies: isLast ? menu.quickReplies : undefined,
        })
      }
      return { messageId }
    }
    let messageId = ''
    for (const part of splitForChannel(menu.text, limit)) {
      messageId = await sendText({ text: part })
    }
    return { messageId }
  } catch (err) {
    if (err instanceof SocialSendError) throw err
    if (isOutsideWindowError(err)) {
      throw new SocialSendError(
        'window_closed',
        `${label} rechazó el envío: la ventana de 24 horas está cerrada.`,
        400,
      )
    }
    if (isThreadControlError(err)) {
      throw new SocialSendError(
        'meta_error',
        `${label}: otra app controla esta conversación (la bandeja de Meta o su IA) y no se pudo tomar el control. Revisa el enrutamiento de conversaciones de la página.`,
        502,
      )
    }
    const message = err instanceof GraphApiError || err instanceof Error ? err.message : String(err)
    throw new SocialSendError('meta_error', `${label}: ${message}`, 502)
  }
}
