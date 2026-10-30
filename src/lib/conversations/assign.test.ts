import { describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { assignConversation } from './assign'

function fakeDb(result: { data?: unknown; error: unknown }) {
  const builder = {
    update: vi.fn(() => builder),
    eq: vi.fn(() => builder),
    is: vi.fn(() => builder),
    select: vi.fn(() => Promise.resolve(result)),
    then: (resolve: (v: unknown) => void) => resolve(result),
  }
  return { db: { from: () => builder } as unknown as SupabaseClient, builder }
}

const base = { conversationId: 'c1', currentUserId: 'me', currentUnread: 0 }

describe('assignConversation', () => {
  it('surfaces the chat when handing it to someone else', async () => {
    const { db, builder } = fakeDb({ error: null })
    await expect(assignConversation(db, { ...base, agentId: 'other' })).resolves.toEqual({ ok: true })
    expect(builder.update).toHaveBeenCalledWith(
      expect.objectContaining({ assigned_agent_id: 'other', unread_count: 1, last_message_at: expect.any(String) }),
    )
  })

  it('leaves the order alone when taking the chat yourself', async () => {
    const { db, builder } = fakeDb({ error: null })
    await assignConversation(db, { ...base, agentId: 'me' })
    expect(builder.update).toHaveBeenCalledWith({ assigned_agent_id: 'me' })
  })

  it('reports a write error', async () => {
    const { db } = fakeDb({ error: 'denied' })
    await expect(assignConversation(db, { ...base, agentId: 'other' })).resolves.toEqual({
      ok: false,
      reason: 'error',
      error: 'denied',
    })
  })

  it('does not overwrite an assignment made after the snapshot', async () => {
    const { db, builder } = fakeDb({ data: [], error: null })
    await expect(
      assignConversation(db, { ...base, agentId: 'other', onlyIfUnassigned: true }),
    ).resolves.toEqual({ ok: false, reason: 'already_assigned' })
    expect(builder.is).toHaveBeenCalledWith('assigned_agent_id', null)
  })

  it('succeeds when the guarded update touched the row', async () => {
    const { db } = fakeDb({ data: [{ id: 'c1' }], error: null })
    await expect(
      assignConversation(db, { ...base, agentId: 'other', onlyIfUnassigned: true }),
    ).resolves.toEqual({ ok: true })
  })
})
