// ============================================================
// TikTok API for Business — Business Messaging (DMs of the TikTok
// Business account). EVERY TikTok endpoint, field name and header the CRM
// uses lives in this file, so that when the app "SAGAMA INOX" is approved
// in TikTok for Business Developers (business-api.tiktok.com) only this
// module has to be checked against the docs.
//
// Everything here is inert without TIKTOK_APP_ID / TIKTOK_APP_SECRET:
// `tiktokEnv()` returns null and every caller turns that into "not
// configured" (the webhook answers 200 and ignores the request; the
// settings card shows "Pendiente de conectar").
//
// Named-object params, same convention as lib/social/graph.ts.
// ============================================================

import crypto from 'node:crypto'

// TODO verificar con docs cuando la app esté aprobada: versión y base de la API.
export const TIKTOK_API_BASE = 'https://business-api.tiktok.com/open_api/v1.3'

// TODO verificar con docs cuando la app esté aprobada: URL de autorización
// de la cuenta TikTok (la que muestra el portal en "Authorization URL").
export const TIKTOK_AUTHORIZE_URL = 'https://www.tiktok.com/v2/auth/authorize/'

// TODO verificar con docs cuando la app esté aprobada: permisos de mensajería.
// Se pueden cambiar sin tocar código con TIKTOK_SCOPES (separados por coma).
export const TIKTOK_DEFAULT_SCOPES = ['user.info.basic', 'biz.message.read', 'biz.message.send']

// TODO verificar con docs cuando la app esté aprobada: rutas de la API.
export const TIKTOK_PATHS = {
  /** Code → access + refresh token of the TikTok account. */
  token: 'tt_user/oauth2/token/',
  /** Refresh an expired access token. */
  refresh: 'tt_user/oauth2/refresh_token/',
  /** Profile of the authorized business account (display name, @username). */
  profile: 'business/get/',
  /** Send a DM. */
  send: 'business/message/send/',
} as const

/** Path of our OAuth callback. Registered in the TikTok portal as the redirect URL. */
export const TIKTOK_CALLBACK_PATH = '/api/tiktok/callback'
/** Path of our webhook. Registered in the TikTok portal as the callback URL. */
export const TIKTOK_WEBHOOK_PATH = '/api/tiktok/webhook'

// TODO verificar con docs cuando la app esté aprobada: cabecera de la firma
// del webhook y su formato `t=<unix>,s=<hex>` (HMAC-SHA256 de "<t>.<cuerpo>"
// con el app secret).
export const TIKTOK_SIGNATURE_HEADER = 'tiktok-signature'
/** Reject signed payloads older than this (replays). */
export const TIKTOK_SIGNATURE_TOLERANCE_S = 10 * 60

// TODO verificar con docs cuando la app esté aprobada: nombres de los eventos
// de mensaje entrante del webhook.
export const TIKTOK_INBOUND_MESSAGE_EVENTS = ['im_receive_msg', 'direct_message', 'message.received']

// TODO verificar con docs cuando la app esté aprobada: a quién se dirige la
// respuesta. Con 'CONVERSATION' el destinatario es el conversation_id del
// webhook, que por eso se guarda como contacts.channel_user_id.
export const TIKTOK_RECIPIENT_TYPE = 'CONVERSATION'

// TODO verificar con docs cuando la app esté aprobada: largo máximo del texto.
export const TIKTOK_TEXT_LIMIT = 1000

/** Refresh the access token when it expires within this margin. */
export const TIKTOK_REFRESH_MARGIN_MS = 5 * 60 * 1000

const TIKTOK_TIMEOUT_MS = 20_000

export interface TikTokEnv {
  appId: string
  appSecret: string
}

/** App credentials, or null while the TikTok app isn't configured (optional env vars). */
export function tiktokEnv(): TikTokEnv | null {
  const appId = process.env.TIKTOK_APP_ID?.trim()
  const appSecret = process.env.TIKTOK_APP_SECRET?.trim()
  if (!appId || !appSecret) return null
  return { appId, appSecret }
}

/**
 * redirect_uri of the OAuth flow. Must match the portal exactly:
 * TIKTOK_REDIRECT_URI when set, otherwise <this deployment>/api/tiktok/callback.
 */
export function tiktokRedirectUri(baseUrl: string): string {
  const override = process.env.TIKTOK_REDIRECT_URI?.trim()
  if (override) return override
  return `${baseUrl.replace(/\/+$/, '')}${TIKTOK_CALLBACK_PATH}`
}

export function tiktokScopes(): string[] {
  const raw = process.env.TIKTOK_SCOPES?.trim()
  if (!raw) return TIKTOK_DEFAULT_SCOPES
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

export class TikTokApiError extends Error {
  readonly code: number | null
  constructor(message: string, code: number | null) {
    super(message)
    this.name = 'TikTokApiError'
    this.code = code
  }
}

/** Envelope of every API for Business answer: `code` 0 = success. */
interface TikTokEnvelope<T> {
  code?: number
  message?: string
  request_id?: string
  data?: T
}

async function tiktokFetch<T>(
  path: string,
  init: { method?: 'GET' | 'POST'; accessToken?: string; body?: unknown; query?: Record<string, string> },
): Promise<T> {
  const url = new URL(`${TIKTOK_API_BASE}/${path}`)
  for (const [k, v] of Object.entries(init.query ?? {})) url.searchParams.set(k, v)
  let res: Response
  try {
    res = await fetch(url, {
      method: init.method ?? 'GET',
      headers: {
        // TODO verificar con docs cuando la app esté aprobada: cabecera del token.
        ...(init.accessToken ? { 'Access-Token': init.accessToken } : {}),
        ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      signal: AbortSignal.timeout(TIKTOK_TIMEOUT_MS),
    })
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      throw new TikTokApiError(`TikTok no respondió en ${TIKTOK_TIMEOUT_MS / 1000} s`, null)
    }
    throw err
  }
  let json: TikTokEnvelope<T> | null = null
  try {
    json = (await res.json()) as TikTokEnvelope<T>
  } catch {
    json = null
  }
  if (!res.ok || !json || (json.code ?? 0) !== 0) {
    throw new TikTokApiError(json?.message || `TikTok API error: ${res.status}`, json?.code ?? null)
  }
  return (json.data ?? ({} as T)) as T
}

// ---- OAuth ------------------------------------------------------------

export function buildAuthorizeUrl(args: { appId: string; redirectUri: string; state: string }): string {
  const url = new URL(TIKTOK_AUTHORIZE_URL)
  // TODO verificar con docs cuando la app esté aprobada: nombre del parámetro
  // del id de la app (client_key / app_id).
  url.searchParams.set('client_key', args.appId)
  url.searchParams.set('scope', tiktokScopes().join(','))
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('redirect_uri', args.redirectUri)
  url.searchParams.set('state', args.state)
  return url.toString()
}

export interface TikTokTokens {
  accessToken: string
  refreshToken: string | null
  /** Id of the authorized TikTok Business account (business_id in the API, user id in the webhook). */
  openId: string
  /** When the access token expires (null = TikTok didn't say). */
  expiresAt: Date | null
  refreshExpiresAt: Date | null
  scope: string | null
}

// TODO verificar con docs cuando la app esté aprobada: campos de la respuesta del token.
interface RawTokenData {
  access_token?: string
  refresh_token?: string
  open_id?: string
  expires_in?: number
  refresh_token_expires_in?: number
  scope?: string
}

function toTokens(d: RawTokenData, fallbackOpenId?: string): TikTokTokens {
  const openId = d.open_id || fallbackOpenId
  if (!d.access_token || !openId) throw new TikTokApiError('TikTok no devolvió el token de acceso', null)
  const now = Date.now()
  return {
    accessToken: d.access_token,
    refreshToken: d.refresh_token ?? null,
    openId,
    expiresAt: typeof d.expires_in === 'number' ? new Date(now + d.expires_in * 1000) : null,
    refreshExpiresAt:
      typeof d.refresh_token_expires_in === 'number' ? new Date(now + d.refresh_token_expires_in * 1000) : null,
    scope: d.scope ?? null,
  }
}

export async function exchangeAuthCode(args: {
  env: TikTokEnv
  code: string
  redirectUri: string
}): Promise<TikTokTokens> {
  const d = await tiktokFetch<RawTokenData>(TIKTOK_PATHS.token, {
    method: 'POST',
    body: {
      client_id: args.env.appId,
      client_secret: args.env.appSecret,
      grant_type: 'authorization_code',
      auth_code: args.code,
      redirect_uri: args.redirectUri,
    },
  })
  return toTokens(d)
}

export async function refreshAccessToken(args: {
  env: TikTokEnv
  refreshToken: string
  openId: string
}): Promise<TikTokTokens> {
  const d = await tiktokFetch<RawTokenData>(TIKTOK_PATHS.refresh, {
    method: 'POST',
    body: {
      client_id: args.env.appId,
      client_secret: args.env.appSecret,
      grant_type: 'refresh_token',
      refresh_token: args.refreshToken,
    },
  })
  return toTokens(d, args.openId)
}

export interface TikTokBusinessProfile {
  displayName: string | null
  username: string | null
}

/** Best-effort profile of the connected account. Null on any error. */
export async function fetchBusinessProfile(args: {
  accessToken: string
  businessId: string
}): Promise<TikTokBusinessProfile | null> {
  try {
    // TODO verificar con docs cuando la app esté aprobada: parámetros y campos del perfil.
    const d = await tiktokFetch<{ display_name?: string; username?: string }>(TIKTOK_PATHS.profile, {
      accessToken: args.accessToken,
      query: { business_id: args.businessId, fields: JSON.stringify(['display_name', 'username']) },
    })
    return { displayName: d.display_name ?? null, username: d.username ?? null }
  } catch (err) {
    console.warn('[tiktok] profile lookup failed:', err instanceof Error ? err.message : err)
    return null
  }
}

// ---- Messages ---------------------------------------------------------

/** Send one text DM. Returns TikTok's message id. */
export async function sendTikTokText(args: {
  accessToken: string
  businessId: string
  recipientId: string
  text: string
}): Promise<string> {
  // TODO verificar con docs cuando la app esté aprobada: cuerpo del envío y
  // dónde viene el id del mensaje en la respuesta.
  const d = await tiktokFetch<{ message?: { message_id?: string }; message_id?: string }>(TIKTOK_PATHS.send, {
    method: 'POST',
    accessToken: args.accessToken,
    body: {
      business_id: args.businessId,
      recipient_type: TIKTOK_RECIPIENT_TYPE,
      recipient: args.recipientId,
      message_type: 'TEXT',
      text: { body: args.text },
    },
  })
  const id = d.message?.message_id ?? d.message_id
  // Without an id the message still went out: keep a local one so the
  // bubble can be stored (it's only used to match replies/statuses).
  return id || `tt_${crypto.randomUUID()}`
}

// ---- Webhook signature ------------------------------------------------

/**
 * Verify the webhook signature: header `t=<unix>,s=<hex>`, where `s` is
 * HMAC-SHA256("<t>.<raw body>", app secret). Fails closed: no secret, no
 * header, a malformed header or a stale timestamp → false.
 */
export function verifyTikTokSignature(
  rawBody: string,
  header: string | null,
  secret: string | null | undefined,
  nowMs: number = Date.now(),
): boolean {
  if (!secret || !header) return false
  const parts = Object.fromEntries(
    header.split(',').map((p) => {
      const i = p.indexOf('=')
      return i === -1 ? [p.trim(), ''] : [p.slice(0, i).trim(), p.slice(i + 1).trim()]
    }),
  ) as Record<string, string>
  const t = parts.t
  const s = parts.s
  if (!t || !s || !/^\d+$/.test(t) || !/^[0-9a-f]+$/i.test(s)) return false
  if (Math.abs(nowMs / 1000 - Number(t)) > TIKTOK_SIGNATURE_TOLERANCE_S) return false
  const expected = crypto.createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex')
  const a = Buffer.from(expected, 'hex')
  const b = Buffer.from(s, 'hex')
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}
