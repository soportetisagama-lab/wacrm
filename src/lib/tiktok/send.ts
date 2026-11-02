// ============================================================
// Outbound TikTok DM. Called only from sendSocialOutbound
// (lib/social/send.ts), after it checked the channel config, the
// recipient and the 24 h window — so every send path of the CRM (inbox,
// public API, Flows, automations, AI auto-reply) reaches TikTok the same
// way it reaches Instagram/Messenger.
//
// The CRM sends text only on TikTok: a menu goes out as numbered text
// (the typed number is mapped back by the inbound pipeline) and media as
// its link plus caption.
// ============================================================

import { supabaseAdmin } from '@/lib/flows/admin-client'
import { decrypt, encrypt } from '@/lib/whatsapp/encryption'
import { splitForChannel } from '@/lib/social/graph'
import { toSocialMenu } from '@/lib/social/interactive'
import type { SocialConfigRow, SocialOutbound } from '@/lib/social/send'
import {
  TIKTOK_REFRESH_MARGIN_MS,
  TIKTOK_TEXT_LIMIT,
  TikTokApiError,
  refreshAccessToken,
  sendTikTokText,
  tiktokEnv,
} from './api'

/** Thrown when the stored credentials can't be used (the caller maps it to "not configured"). */
export class TikTokNotConfiguredError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TikTokNotConfiguredError'
  }
}

/** The text(s) to send for one outbound message. */
export function tiktokTextsFor(outbound: SocialOutbound): string[] {
  if (outbound.kind === 'text') return splitForChannel(outbound.text, TIKTOK_TEXT_LIMIT)
  if (outbound.kind === 'media') {
    const text = [outbound.caption?.trim(), outbound.url].filter(Boolean).join('\n')
    return splitForChannel(text, TIKTOK_TEXT_LIMIT)
  }
  return splitForChannel(toSocialMenu(outbound.payload, { quickReplies: false }).text, TIKTOK_TEXT_LIMIT)
}

/** A usable access token: the stored one, or a refreshed one (saved back, encrypted). */
export async function tiktokAccessToken(config: SocialConfigRow): Promise<string> {
  let accessToken: string
  try {
    accessToken = decrypt(config.access_token)
  } catch {
    throw new TikTokNotConfiguredError('No se pudo leer el token de TikTok. Vuelve a conectar la cuenta en Configuración.')
  }
  const expiresAt = config.token_expires_at ? Date.parse(config.token_expires_at) : NaN
  if (Number.isNaN(expiresAt) || expiresAt - Date.now() > TIKTOK_REFRESH_MARGIN_MS) return accessToken

  const env = tiktokEnv()
  if (!env || !config.refresh_token) {
    throw new TikTokNotConfiguredError('El token de TikTok venció. Vuelve a conectar la cuenta en Configuración.')
  }
  let refreshToken: string
  try {
    refreshToken = decrypt(config.refresh_token)
  } catch {
    throw new TikTokNotConfiguredError('No se pudo leer el token de TikTok. Vuelve a conectar la cuenta en Configuración.')
  }
  let tokens
  try {
    tokens = await refreshAccessToken({ env, refreshToken, openId: config.external_id })
  } catch (err) {
    console.error('[tiktok] token refresh failed:', err instanceof Error ? err.message : err)
    throw new TikTokNotConfiguredError('TikTok no renovó el token. Vuelve a conectar la cuenta en Configuración.')
  }
  const { error } = await supabaseAdmin()
    .from('social_channel_configs')
    .update({
      access_token: encrypt(tokens.accessToken),
      refresh_token: tokens.refreshToken ? encrypt(tokens.refreshToken) : config.refresh_token,
      token_expires_at: tokens.expiresAt?.toISOString() ?? null,
      refresh_token_expires_at: tokens.refreshExpiresAt?.toISOString() ?? config.refresh_token_expires_at ?? null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', config.id)
  if (error) console.error('[tiktok] saving the refreshed token failed:', error.message)
  return tokens.accessToken
}

/** Send to a TikTok contact. Returns the id of the last message sent. Throws TikTokApiError / TikTokNotConfiguredError. */
export async function sendTikTokOutbound(args: {
  config: SocialConfigRow
  recipientId: string
  outbound: SocialOutbound
}): Promise<{ messageId: string }> {
  const texts = tiktokTextsFor(args.outbound)
  if (texts.length === 0) throw new TikTokApiError('El mensaje está vacío.', null)
  const accessToken = await tiktokAccessToken(args.config)
  let messageId = ''
  for (const text of texts) {
    messageId = await sendTikTokText({
      accessToken,
      businessId: args.config.external_id,
      recipientId: args.recipientId,
      text,
    })
  }
  return { messageId }
}
