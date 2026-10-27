// ============================================================
// Messaging channels (migration 080).
//
// Every contact and conversation belongs to exactly one channel.
// WhatsApp is the default for every row that predates the migration (and
// for any row read before the migration runs: the column is then simply
// absent, so `channelOf` falls back to 'whatsapp').
//
// 'tiktok' is reserved in the type and in the DB CHECK constraint but has
// no implementation yet: nothing creates such rows today.
// ============================================================

export const CHANNELS = ['whatsapp', 'instagram', 'messenger', 'tiktok'] as const
export type Channel = (typeof CHANNELS)[number]

/** Channels reached through Meta's Messenger Platform (Graph Send API). */
export const SOCIAL_CHANNELS = ['instagram', 'messenger'] as const
export type SocialChannel = (typeof SOCIAL_CHANNELS)[number]

export function isChannel(value: unknown): value is Channel {
  return typeof value === 'string' && (CHANNELS as readonly string[]).includes(value)
}

export function isSocialChannel(value: unknown): value is SocialChannel {
  return typeof value === 'string' && (SOCIAL_CHANNELS as readonly string[]).includes(value)
}

/** Channel of a contact/conversation row; anything unknown or missing → whatsapp. */
export function channelOf(row: { channel?: string | null } | null | undefined): Channel {
  const value = row?.channel
  return isChannel(value) ? value : 'whatsapp'
}

/** Human label shown in the UI (brand names: not translated). */
export const CHANNEL_LABEL: Record<Channel, string> = {
  whatsapp: 'WhatsApp',
  instagram: 'Instagram',
  messenger: 'Facebook',
  tiktok: 'TikTok',
}

/**
 * Meta's standard messaging window for Instagram and Messenger: a business
 * may reply freely for 24 h after the person's last message. (Outside it
 * only message tags such as HUMAN_AGENT apply, which this CRM doesn't use.)
 */
export const SOCIAL_MESSAGING_WINDOW_MS = 24 * 60 * 60 * 1000

export function isWithinMessagingWindow(
  lastCustomerMessageAt: string | Date | null | undefined,
  now: Date = new Date(),
): boolean {
  if (!lastCustomerMessageAt) return false
  const at =
    lastCustomerMessageAt instanceof Date
      ? lastCustomerMessageAt.getTime()
      : Date.parse(lastCustomerMessageAt)
  if (Number.isNaN(at)) return false
  return now.getTime() - at < SOCIAL_MESSAGING_WINDOW_MS
}

/**
 * Who can see Instagram/Messenger chats. Mirrors the SQL helper
 * can_view_social_channel() in migration 080 (which is what actually
 * enforces it, through RLS): WhatsApp is never restricted here; social
 * channels are owner/admin only unless the account switched on
 * "Mostrar estos chats también a los asesores", in which case the normal
 * per-role conversation rules apply. Community Manager always sees
 * Instagram/Messenger (migration 084).
 */
export function canViewChannel(args: {
  channel: Channel
  role: string
  showToAgents: boolean
}): boolean {
  if (args.channel === 'whatsapp') return true
  if (args.role === 'owner' || args.role === 'admin') return true
  // Community Manager works Instagram/Messenger whatever the toggle says
  // (migration 084). TikTok isn't one of its channels.
  if (args.role === 'community_manager') {
    return args.channel === 'instagram' || args.channel === 'messenger'
  }
  return args.showToAgents
}

/**
 * Features that only exist on WhatsApp (templates, broadcasts, calls,
 * line transfers, reactions, XLR8 sync…) need a phone number; contacts
 * from other channels never have one, so these features must skip them.
 */
export function supportsWhatsAppFeatures(row: {
  channel?: string | null
  phone?: string | null
}): boolean {
  return channelOf(row) === 'whatsapp' && !!row.phone
}
