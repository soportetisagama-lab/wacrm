import { describe, it, expect, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  CALL_PERMISSION_MESSAGE,
  assignedAdvisorHasReplied,
  hasRecentHumanReply,
  isAutomaticAgentText,
  isManualAiPause,
} from './human-activity'
import { transferNoticeText } from '@/lib/line-transfer'

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

function mockAdvisorDb(result: { data: unknown; error: unknown }) {
  const chain = {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    or: vi.fn().mockReturnThis(),
    order: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue(result),
  }
  return { db: { from: vi.fn(() => chain) } as unknown as SupabaseClient, chain }
}

describe('assignedAdvisorHasReplied', () => {
  it('is true when the assigned advisor wrote a real message', async () => {
    const { db, chain } = mockAdvisorDb({ data: [{ content_text: 'Hola, soy tu asesor' }], error: null })
    expect(await assignedAdvisorHasReplied(db, 'c1', 'u1')).toBe(true)
    expect(chain.eq).toHaveBeenCalledWith('sender_type', 'agent')
    expect(chain.or).toHaveBeenCalledWith(expect.stringContaining('sender_id.eq.u1'))
  })
  it('is false with no message of the advisor', async () => {
    const { db } = mockAdvisorDb({ data: [], error: null })
    expect(await assignedAdvisorHasReplied(db, 'c1', 'u1')).toBe(false)
  })
  it('ignores automatic texts stored as agent (call permission, line-transfer notice)', async () => {
    const { db } = mockAdvisorDb({
      data: [
        { content_text: CALL_PERMISSION_MESSAGE },
        { content_text: transferNoticeText({ topic: 'tuberías', targetLabel: 'Sagama X' }) },
      ],
      error: null,
    })
    expect(await assignedAdvisorHasReplied(db, 'c1', 'u1')).toBe(false)
  })
  it('a media message without text counts as the advisor writing', async () => {
    const { db } = mockAdvisorDb({ data: [{ content_text: null }], error: null })
    expect(await assignedAdvisorHasReplied(db, 'c1', 'u1')).toBe(true)
  })
  it('fails toward quiet (true) on a read error', async () => {
    const { db } = mockAdvisorDb({ data: null, error: { message: 'boom' } })
    expect(await assignedAdvisorHasReplied(db, 'c1', 'u1')).toBe(true)
  })
})

describe('isAutomaticAgentText', () => {
  it('only matches the canned texts', () => {
    expect(isAutomaticAgentText(CALL_PERMISSION_MESSAGE)).toBe(true)
    expect(isAutomaticAgentText('Te llamo en 5 minutos')).toBe(false)
    expect(isAutomaticAgentText(null)).toBe(false)
  })
})

describe('isManualAiPause', () => {
  it('paused and not pending is a manual pause; a handoff (pending) is not', () => {
    expect(isManualAiPause({ ai_autoreply_disabled: true, status: 'open' })).toBe(true)
    expect(isManualAiPause({ ai_autoreply_disabled: true, status: 'pending' })).toBe(false)
    expect(isManualAiPause({ ai_autoreply_disabled: false, status: 'open' })).toBe(false)
  })
})
