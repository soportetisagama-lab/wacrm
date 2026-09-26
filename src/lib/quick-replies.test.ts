import { describe, it, expect } from 'vitest'
import { canManageQuickReply, canSeeQuickReply, isQuickReplyAdmin } from './quick-replies'

const shared = { user_id: 'admin-1', is_shared: true }
const mine = { user_id: 'agent-1', is_shared: false }
const theirs = { user_id: 'agent-2', is_shared: false }
const agent = { userId: 'agent-1', role: 'agent' as const }
const owner = { userId: 'admin-1', role: 'owner' as const }

describe('quick reply visibility', () => {
  it('an advisor sees shared replies and their own, never another advisor’s', () => {
    expect(canSeeQuickReply(agent, shared)).toBe(true)
    expect(canSeeQuickReply(agent, mine)).toBe(true)
    expect(canSeeQuickReply(agent, theirs)).toBe(false)
  })

  it('an admin sees everything', () => {
    expect(canSeeQuickReply(owner, theirs)).toBe(true)
  })

  it('rows from before the migration (no is_shared) count as shared', () => {
    expect(canSeeQuickReply(agent, { user_id: 'x' })).toBe(true)
  })
})

describe('quick reply management', () => {
  it('an advisor manages only their own personal replies', () => {
    expect(canManageQuickReply(agent, mine)).toBe(true)
    expect(canManageQuickReply(agent, theirs)).toBe(false)
    expect(canManageQuickReply(agent, shared)).toBe(false)
    expect(canManageQuickReply(agent, { user_id: 'agent-1', is_shared: true })).toBe(false)
  })

  it('admin and owner manage everything; gerencia/atc do not count as admin', () => {
    expect(canManageQuickReply(owner, theirs)).toBe(true)
    expect(isQuickReplyAdmin('admin')).toBe(true)
    expect(isQuickReplyAdmin('gerencia')).toBe(false)
    expect(isQuickReplyAdmin('atc')).toBe(false)
  })
})
