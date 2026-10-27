// ============================================================
// The contact + conversation of an Instagram / Messenger user, found or
// created by their PSID / IGSID. Shared by the inbound webhook
// (./inbound) and the comment private reply (./comments), so a DM the
// bot sends from a comment lands in the same thread the customer's
// answer will.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'

import { decrypt } from '@/lib/whatsapp/encryption'
import { isUniqueViolation } from '@/lib/contacts/dedupe'
import { CHANNEL_LABEL, type SocialChannel } from '@/lib/channels/types'
import { fetchSocialProfile } from './graph'
import type { SocialConfigRow } from './send'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = any

export async function findOrCreateSocialContact(
  db: SupabaseClient,
  config: Pick<SocialConfigRow, 'account_id' | 'user_id' | 'access_token'>,
  channel: SocialChannel,
  senderId: string,
): Promise<{ contact: Row; wasCreated: boolean } | null> {
  const lookup = () =>
    db
      .from('contacts')
      .select('*')
      .eq('account_id', config.account_id)
      .eq('channel', channel)
      .eq('channel_user_id', senderId)
      .maybeSingle()

  const { data: existing } = await lookup()
  if (existing) return { contact: existing, wasCreated: false }

  let profile = null
  try {
    profile = await fetchSocialProfile({
      channel: channel,
      userId: senderId,
      accessToken: decrypt(config.access_token),
    })
  } catch {
    profile = null
  }
  const label = CHANNEL_LABEL[channel]
  const name =
    profile?.name || (profile?.username ? `@${profile.username}` : null) || `Usuario de ${label}`

  const { data: created, error } = await db
    .from('contacts')
    .insert({
      account_id: config.account_id,
      user_id: config.user_id,
      phone: null,
      channel: channel,
      channel_user_id: senderId,
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

export async function findOrCreateSocialConversation(
  db: SupabaseClient,
  config: Pick<SocialConfigRow, 'account_id' | 'user_id'>,
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
