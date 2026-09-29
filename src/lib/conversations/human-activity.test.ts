import { describe, it, expect, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { hasRecentHumanReply } from './human-activity'

function mockDb(result: { data: unknown; error: unknown }) {
  const chain = {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    gte: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue(result),
  }
  return { db: { from: vi.fn(() => chain) } as unknown as SupabaseClient, chain }
}

describe('hasRecentHumanReply', () => {
  it('is true when a teammate (sender_type agent) wrote recently', async () => {
    const { db, chain } = mockDb({ data: [{ id: 'm1' }], error: null })
    expect(await hasRecentHumanReply(db, 'c1')).toBe(true)
    expect(chain.eq).toHaveBeenCalledWith('sender_type', 'agent')
  })
  it('is false with no recent human message', async () => {
    const { db } = mockDb({ data: [], error: null })
    expect(await hasRecentHumanReply(db, 'c1')).toBe(false)
  })
  it('fails open (false) on a read error', async () => {
    const { db } = mockDb({ data: null, error: { message: 'boom' } })
    expect(await hasRecentHumanReply(db, 'c1')).toBe(false)
  })
})
