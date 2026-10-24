// ============================================================
// Graph API calls for Instagram (DM) and Messenger — Messenger Platform
// Send API with a Page access token (Instagram through the Facebook Page
// it's linked to, i.e. "Instagram API with Facebook Login").
//
// Named-object params, same convention as lib/whatsapp/meta-api.ts.
// ============================================================

import type { SocialChannel } from '@/lib/channels/types'
import type { QuickReply } from './interactive'

const GRAPH_VERSION = 'v21.0'
const GRAPH_BASE = `https://graph.facebook.com/${GRAPH_VERSION}`

/** Per-message text limits (characters). Instagram is stricter. */
export const SOCIAL_TEXT_LIMIT: Record<SocialChannel, number> = {
  instagram: 1000,
  messenger: 2000,
}

/** Fields the page subscribes this app to (Messenger + Instagram). */
export const PAGE_SUBSCRIBED_FIELDS = [
  'messages',
  'messaging_postbacks',
  'messaging_referrals',
  // Messages delivered while another app (Meta's inbox, Meta Business
  // AI…) controls the thread — handover protocol / conversation routing.
  'standby',
]

export class GraphApiError extends Error {
  readonly code: number | null
  readonly subcode: number | null
  constructor(message: string, code: number | null, subcode: number | null) {
    super(message)
    this.name = 'GraphApiError'
    this.code = code
    this.subcode = subcode
  }
}

/**
 * Meta's "outside the allowed window" errors: code 10 / subcode 2018278
 * (Messenger) and 2534022 (Instagram). Mapped to a clear message in the UI.
 */
export function isOutsideWindowError(err: unknown): boolean {
  if (!(err instanceof GraphApiError)) return false
  return err.subcode === 2018278 || err.subcode === 2534022 || /outside of allowed window/i.test(err.message)
}

/**
 * Meta refused the send because another app controls the thread
 * (handover protocol / conversation routing). Meta doesn't document a
 * single stable subcode for this, so match on the message too.
 */
export function isThreadControlError(err: unknown): boolean {
  if (!(err instanceof GraphApiError)) return false
  if (isOutsideWindowError(err)) return false
  return /thread (control|owner)|handover|not (the )?(thread )?owner|does not (have|own) (the )?thread/i.test(err.message)
}

async function graphFetch<T>(
  path: string,
  init: { method?: 'GET' | 'POST' | 'DELETE'; accessToken: string; body?: unknown },
): Promise<T> {
  const url = `${GRAPH_BASE}/${path}`
  const res = await fetch(url, {
    method: init.method ?? 'GET',
    headers: {
      Authorization: `Bearer ${init.accessToken}`,
      ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  })
  let data: unknown = null
  try {
    data = await res.json()
  } catch {
    data = null
  }
  if (!res.ok) {
    const e = (data as { error?: { message?: string; code?: number; error_subcode?: number } } | null)?.error
    throw new GraphApiError(
      e?.message ?? `Graph API error: ${res.status}`,
      e?.code ?? null,
      e?.error_subcode ?? null,
    )
  }
  return data as T
}

/** Split text into chunks that fit the channel's limit, on line/word breaks when possible. */
export function splitForChannel(text: string, limit: number): string[] {
  const out: string[] = []
  let rest = text.trim()
  while (rest.length > limit) {
    let cut = rest.lastIndexOf('\n', limit)
    if (cut < limit * 0.5) cut = rest.lastIndexOf(' ', limit)
    if (cut < limit * 0.5) cut = limit
    out.push(rest.slice(0, cut).trim())
    rest = rest.slice(cut).trim()
  }
  if (rest) out.push(rest)
  return out
}

interface SendResponse {
  recipient_id?: string
  message_id?: string
}

export interface SocialSendTarget {
  accessToken: string
  /** PSID / IGSID. */
  recipientId: string
}

async function sendMessagePayload(
  target: SocialSendTarget,
  message: Record<string, unknown>,
): Promise<string> {
  const data = await graphFetch<SendResponse>('me/messages', {
    method: 'POST',
    accessToken: target.accessToken,
    body: {
      recipient: { id: target.recipientId },
      messaging_type: 'RESPONSE',
      message,
    },
  })
  if (!data.message_id) throw new GraphApiError('Graph API did not return a message id', null, null)
  return data.message_id
}

export async function sendSocialText(
  args: SocialSendTarget & { text: string; quickReplies?: QuickReply[] },
): Promise<string> {
  return sendMessagePayload(args, {
    text: args.text,
    ...(args.quickReplies && args.quickReplies.length > 0 ? { quick_replies: args.quickReplies } : {}),
  })
}

export type SocialAttachmentType = 'image' | 'video' | 'audio' | 'file'

export async function sendSocialAttachment(
  args: SocialSendTarget & { type: SocialAttachmentType; url: string },
): Promise<string> {
  return sendMessagePayload(args, {
    attachment: { type: args.type, payload: { url: args.url, is_reusable: false } },
  })
}

/**
 * Handover protocol: make this app the thread owner for one person
 * (`POST /me/take_thread_control`, `me` = the Page of the token; works
 * for Messenger PSIDs and Instagram IGSIDs). Meta only allows it when
 * the Page's conversation routing gives this app control.
 */
export async function takeThreadControl(args: SocialSendTarget & { metadata?: string }): Promise<void> {
  await graphFetch<{ success?: boolean }>('me/take_thread_control', {
    method: 'POST',
    accessToken: args.accessToken,
    body: {
      recipient: { id: args.recipientId },
      metadata: args.metadata ?? 'CRM SAGAMA toma la conversación',
    },
  })
}

export interface SocialProfile {
  name: string | null
  username: string | null
  avatarUrl: string | null
}

/** Best-effort sender profile (name, @username, picture). Null on any error. */
export async function fetchSocialProfile(args: {
  channel: SocialChannel
  userId: string
  accessToken: string
}): Promise<SocialProfile | null> {
  try {
    if (args.channel === 'instagram') {
      const d = await graphFetch<{ name?: string; username?: string; profile_pic?: string }>(
        `${encodeURIComponent(args.userId)}?fields=name,username,profile_pic`,
        { accessToken: args.accessToken },
      )
      return { name: d.name ?? null, username: d.username ?? null, avatarUrl: d.profile_pic ?? null }
    }
    const d = await graphFetch<{ first_name?: string; last_name?: string; name?: string; profile_pic?: string }>(
      `${encodeURIComponent(args.userId)}?fields=first_name,last_name,profile_pic`,
      { accessToken: args.accessToken },
    )
    const name = [d.first_name, d.last_name].filter(Boolean).join(' ') || d.name || null
    return { name, username: null, avatarUrl: d.profile_pic ?? null }
  } catch (err) {
    console.warn('[social] profile lookup failed:', err instanceof Error ? err.message : err)
    return null
  }
}

export interface PageInfo {
  id: string
  name: string | null
  instagram: { id: string; username: string | null; name: string | null } | null
}

/**
 * The admin may paste a user / system-user token instead of a Page token.
 * Page endpoints (subscribed_apps, Send API) need the Page token, so ask
 * Meta for it; a Page token derived from a never-expiring system-user
 * token never expires either. Falls back to the pasted token when Meta
 * doesn't return one (e.g. it already is a Page token).
 */
export async function resolvePageAccessToken(args: { pageId: string; accessToken: string }): Promise<string> {
  try {
    const d = await graphFetch<{ access_token?: string }>(
      `${encodeURIComponent(args.pageId)}?fields=access_token`,
      { accessToken: args.accessToken },
    )
    return d.access_token || args.accessToken
  } catch {
    return args.accessToken
  }
}

/** Validate a Page token and discover the linked Instagram professional account. */
export async function fetchPageInfo(args: { pageId: string; accessToken: string }): Promise<PageInfo> {
  const d = await graphFetch<{
    id: string
    name?: string
    instagram_business_account?: { id: string; username?: string; name?: string }
  }>(`${encodeURIComponent(args.pageId)}?fields=id,name,instagram_business_account{id,username,name}`, {
    accessToken: args.accessToken,
  })
  const ig = d.instagram_business_account
  return {
    id: d.id,
    name: d.name ?? null,
    instagram: ig ? { id: ig.id, username: ig.username ?? null, name: ig.name ?? null } : null,
  }
}

/** Subscribe the page to this app's webhook (covers Messenger and the linked Instagram). */
export async function subscribePageToApp(args: { pageId: string; accessToken: string }): Promise<void> {
  await graphFetch<{ success?: boolean }>(
    `${encodeURIComponent(args.pageId)}/subscribed_apps?subscribed_fields=${PAGE_SUBSCRIBED_FIELDS.join(',')}`,
    { method: 'POST', accessToken: args.accessToken },
  )
}
