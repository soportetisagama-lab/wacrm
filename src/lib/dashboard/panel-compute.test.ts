import { describe, expect, it } from 'vitest'
import {
  answeredTodayPct,
  agentRanking,
  callsByAgent,
  coldConversations,
  hourlyActivity,
  openWindows,
  responseSamples,
  threadStates,
  transfersByLine,
  unreturnedMissedCalls,
  waitingConversations,
  type PanelCall,
  type PanelConversation,
  type PanelMessage,
} from './panel-compute'

const NOW = new Date(2026, 9, 10, 15, 0, 0).getTime() // Oct 10 2026, 15:00 local
const at = (minutesAgo: number) => new Date(NOW - minutesAgo * 60_000).toISOString()

const conv = (id: string, over: Partial<PanelConversation> = {}): PanelConversation => ({
  id,
  contact_id: `ct-${id}`,
  status: 'open',
  assigned_agent_id: 'a1',
  last_message_at: at(1),
  last_message_text: null,
  unread_count: 0,
  created_at: at(5000),
  contact: { name: id, phone: null, whatsapp_user_id: null },
  ...over,
})
const msg = (conversation_id: string, sender_type: PanelMessage['sender_type'], minutesAgo: number, sender_id: string | null = null): PanelMessage => ({
  conversation_id,
  sender_type,
  sender_id,
  created_at: at(minutesAgo),
})

describe('waitingConversations', () => {
  it('lists chats where the customer spoke last, longest wait first', () => {
    const messages = [
      msg('a', 'customer', 50), msg('a', 'agent', 40), msg('a', 'customer', 20), msg('a', 'customer', 10),
      msg('b', 'customer', 90),
      msg('c', 'customer', 30), msg('c', 'agent', 5),
    ]
    const res = waitingConversations([conv('a'), conv('b'), conv('c')], threadStates(messages), NOW)
    expect(res.map((r) => [r.conversation.id, Math.round(r.waitingMs / 60_000)])).toEqual([['b', 90], ['a', 20]])
  })

  it('falls back to unread_count when no messages were loaded for a chat', () => {
    const res = waitingConversations([conv('x', { unread_count: 2, last_message_at: at(60) })], new Map(), NOW)
    expect(res).toHaveLength(1)
  })
})

describe('openWindows', () => {
  it('keeps windows still open, soonest to close first', () => {
    const messages = [msg('a', 'customer', 23 * 60), msg('b', 'customer', 60), msg('c', 'customer', 25 * 60)]
    const res = openWindows([conv('a'), conv('b'), conv('c')], threadStates(messages), NOW)
    expect(res.map((r) => [r.conversation.id, Math.round(r.remainingMs / 60_000)])).toEqual([['a', 60], ['b', 23 * 60]])
  })
})

describe('coldConversations', () => {
  it('lists chats where we wrote last 3+ days ago', () => {
    const messages = [msg('a', 'customer', 5 * 1440), msg('a', 'agent', 4 * 1440), msg('b', 'customer', 4 * 1440), msg('c', 'agent', 60)]
    const convs = [conv('a', { last_message_at: at(4 * 1440) }), conv('b', { last_message_at: at(4 * 1440) }), conv('c', { last_message_at: at(60) })]
    expect(coldConversations(convs, threadStates(messages), NOW).map((r) => r.conversation.id)).toEqual(['a'])
  })
})

describe('answeredTodayPct', () => {
  it('counts chats with a customer message today that got any reply after it', () => {
    const messages = [msg('a', 'customer', 100), msg('a', 'bot', 99), msg('b', 'customer', 50), msg('c', 'agent', 40), msg('c', 'customer', 30)]
    expect(answeredTodayPct(messages, NOW)).toBe(33)
    expect(answeredTodayPct([], NOW)).toBeNull()
  })
})

describe('responseSamples / agentRanking', () => {
  it('pairs the first unanswered customer message with the next agent reply', () => {
    const messages = [msg('a', 'customer', 30), msg('a', 'customer', 25), msg('a', 'bot', 24), msg('a', 'agent', 20, 'u1')]
    expect(responseSamples(messages)).toEqual([expect.objectContaining({ minutes: 10, responderId: 'u1' })])
  })

  it('ranks agents by chats attended', () => {
    const messages = [
      msg('a', 'customer', 30), msg('a', 'agent', 20, 'u1'),
      msg('b', 'customer', 30), msg('b', 'agent', 25, 'u2'), msg('c', 'agent', 10, 'u2'),
    ]
    const res = agentRanking(['u1', 'u2'], messages, new Map([['u1', 4]]), NOW - 3600_000)
    expect(res.map((r) => [r.userId, r.attended, r.sent, r.closed, r.medianResponse])).toEqual([
      ['u2', 2, 2, 0, 5],
      ['u1', 1, 1, 4, 10],
    ])
  })
})

describe('hourlyActivity', () => {
  it('buckets today by local hour', () => {
    const res = hourlyActivity([msg('a', 'customer', 30), msg('a', 'agent', 20), msg('a', 'agent', 24 * 60)], NOW)
    expect(res[14]).toEqual({ hour: 14, sent: 1, received: 1 })
  })
})

describe('calls', () => {
  const call = (id: string, over: Partial<PanelCall>): PanelCall => ({
    id, conversation_id: null, contact_id: 'k1', direction: 'inbound', status: 'missed',
    ring_user_id: 'u1', answered_by: null, answered_at: null, created_at: at(60), contact: null, ...over,
  })

  it('drops missed calls that were later called back or answered', () => {
    const calls = [
      call('1', { contact_id: 'k1', created_at: at(60) }),
      call('2', { contact_id: 'k1', direction: 'outbound', status: 'ended', created_at: at(30) }),
      call('3', { contact_id: 'k2', created_at: at(50) }),
      call('4', { contact_id: 'k3', created_at: at(40) }),
      call('5', { contact_id: 'k3', status: 'ended', answered_at: at(20), created_at: at(20) }),
    ]
    expect(unreturnedMissedCalls(calls).map((c) => c.id)).toEqual(['3'])
  })

  it('counts answered vs missed per agent', () => {
    const res = callsByAgent([
      call('1', { status: 'ended', answered_by: 'u1', answered_at: at(1) }),
      call('2', {}),
      call('3', { ring_user_id: null }),
    ])
    expect(res.get('u1')).toEqual({ answered: 1, missed: 1 })
    expect(res.get(null)).toEqual({ answered: 0, missed: 1 })
  })
})

describe('transfersByLine', () => {
  it('parses both sides of the transfer notes', () => {
    const res = transfersByLine([
      { note_text: '🔀 Derivado a Sagama Maxi — tema: hornos. Sagama Maxi ya le escribió…' },
      { note_text: '🔀 Derivado a Sagama Maxi — tema: mesas.' },
      { note_text: '🔀 Derivado desde Sagama Castor por Karina — tema: cocina' },
      { note_text: 'Llamar el lunes' },
    ])
    expect(res).toEqual([
      { line: 'Sagama Maxi', sent: 2, received: 0 },
      { line: 'Sagama Castor', sent: 0, received: 1 },
    ])
  })
})
