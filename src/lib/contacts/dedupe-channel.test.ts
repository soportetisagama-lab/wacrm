import type { SupabaseClient } from '@supabase/supabase-js'
import { describe, expect, it } from 'vitest'
import { findExistingContact } from './dedupe'

function dbReturning(rows: Record<string, unknown>[]): SupabaseClient {
  const builder = {
    select: () => builder,
    eq: () => builder,
    like: () => Promise.resolve({ data: rows, error: null }),
  }
  return { from: () => builder } as unknown as SupabaseClient
}

describe('findExistingContact — channel guard', () => {
  it('never matches an Instagram / Facebook contact by phone', async () => {
    const db = dbReturning([
      { id: 'ig-1', phone: '+51999888777', channel: 'instagram' },
      { id: 'fb-1', phone: '+51999888777', channel: 'messenger' },
    ])
    expect(await findExistingContact(db, 'acct', '+51999888777')).toBeNull()
  })

  it('still matches WhatsApp contacts, with or without the channel column (pre-080)', async () => {
    const db = dbReturning([
      { id: 'ig-1', phone: '+51999888777', channel: 'instagram' },
      { id: 'wa-1', phone: '+51999888777' },
    ])
    expect((await findExistingContact(db, 'acct', '51999888777'))?.id).toBe('wa-1')
  })
})
