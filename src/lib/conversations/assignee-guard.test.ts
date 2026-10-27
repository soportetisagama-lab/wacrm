import { describe, expect, it } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { canAssignAgentToContact, canAssignAgentToConversation } from './assignee-guard'

/** Minimal fake: profiles → role, conversations/contacts → channel (or error). */
function fakeDb(opts: { role: string | null; channel?: string | null; channelError?: boolean }) {
  const reads: string[] = []
  const db = {
    from: (table: string) => {
      reads.push(table)
      const chain = {
        select: () => chain,
        eq: () => chain,
        maybeSingle: () => {
          if (table === 'profiles') {
            return Promise.resolve({ data: opts.role ? { account_role: opts.role } : null, error: null })
          }
          if (opts.channelError) {
            return Promise.resolve({ data: null, error: { message: 'column "channel" does not exist' } })
          }
          return Promise.resolve({ data: { channel: opts.channel ?? null }, error: null })
        },
      }
      return chain
    },
  }
  return { db: db as unknown as SupabaseClient, reads }
}

describe('canAssignAgentToConversation', () => {
  it('allows any non-Community-Manager without reading the channel', async () => {
    const { db, reads } = fakeDb({ role: 'agent', channel: 'whatsapp' })
    expect(await canAssignAgentToConversation(db, 'u1', 'c1')).toBe(true)
    expect(reads).toEqual(['profiles'])
  })

  it('blocks a Community Manager on WhatsApp and allows it on Instagram/Messenger', async () => {
    expect(await canAssignAgentToConversation(fakeDb({ role: 'community_manager', channel: 'whatsapp' }).db, 'u1', 'c1')).toBe(false)
    expect(await canAssignAgentToConversation(fakeDb({ role: 'community_manager', channel: 'instagram' }).db, 'u1', 'c1')).toBe(true)
    expect(await canAssignAgentToContact(fakeDb({ role: 'community_manager', channel: 'messenger' }).db, 'u1', 'k1')).toBe(true)
  })

  it('fails closed for a Community Manager when the channel cannot be read', async () => {
    const { db } = fakeDb({ role: 'community_manager', channelError: true })
    expect(await canAssignAgentToConversation(db, 'u1', 'c1')).toBe(false)
    expect(await canAssignAgentToContact(db, 'u1', 'k1')).toBe(false)
  })
})
