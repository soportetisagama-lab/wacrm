// Pure aggregation for the role-based Panel (see panel-queries.ts for
// the reads). Everything here comes from inbox data only — the lines
// don't use pipelines/deals yet — and takes `now` explicitly so it's
// unit-testable.

import { mondayIndex, startOfLocalDay } from './date-utils'

export const WINDOW_MS = 24 * 60 * 60 * 1000
/** A 24h window counts as "por vencer" when this little of it is left. */
export const WINDOW_SOON_MS = 3 * 60 * 60 * 1000
/** A customer waiting longer than this shows up as "esperando". */
export const WAIT_ALERT_MS = 15 * 60 * 1000
/** Open chats whose last message is ours and older than this are "dejaron de responder". */
export const COLD_AFTER_MS = 3 * 24 * 60 * 60 * 1000

export interface ContactRef {
  name: string | null
  phone: string | null
  whatsapp_user_id: string | null
}

export interface PanelConversation {
  id: string
  contact_id: string
  status: 'open' | 'pending' | 'closed'
  assigned_agent_id: string | null
  last_message_at: string | null
  last_message_text: string | null
  unread_count: number | null
  created_at: string
  contact: ContactRef | null
}

export interface PanelMessage {
  conversation_id: string
  sender_type: 'customer' | 'agent' | 'bot'
  sender_id: string | null
  created_at: string
}

export function contactName(c: ContactRef | null | undefined): string {
  return c?.name || c?.phone || c?.whatsapp_user_id || 'Cliente'
}

/** Per-conversation facts derived from its messages. */
export interface ThreadState {
  lastSender: PanelMessage['sender_type'] | null
  lastCustomerAt: number | null
  /** First customer message after our last reply — null when we replied last. */
  waitingSince: number | null
}

/** Messages must be in ascending created_at order. */
export function threadStates(messages: PanelMessage[]): Map<string, ThreadState> {
  const out = new Map<string, ThreadState>()
  for (const m of messages) {
    const ts = new Date(m.created_at).getTime()
    const s = out.get(m.conversation_id) ?? { lastSender: null, lastCustomerAt: null, waitingSince: null }
    s.lastSender = m.sender_type
    if (m.sender_type === 'customer') {
      s.lastCustomerAt = ts
      if (s.waitingSince === null) s.waitingSince = ts
    } else {
      s.waitingSince = null
    }
    out.set(m.conversation_id, s)
  }
  return out
}

export interface WaitingItem {
  conversation: PanelConversation
  waitingMs: number
}

export interface WindowItem {
  conversation: PanelConversation
  remainingMs: number
}

/** Open chats where the customer spoke last, longest wait first. */
export function waitingConversations(
  convs: PanelConversation[],
  states: Map<string, ThreadState>,
  now: number,
): WaitingItem[] {
  const out: WaitingItem[] = []
  for (const c of convs) {
    const s = states.get(c.id)
    if (s) {
      if (s.waitingSince !== null) out.push({ conversation: c, waitingMs: now - s.waitingSince })
    } else if ((c.unread_count ?? 0) > 0 && c.last_message_at) {
      // No messages in the loaded range — fall back to the unread flag.
      out.push({ conversation: c, waitingMs: now - new Date(c.last_message_at).getTime() })
    }
  }
  return out.sort((a, b) => b.waitingMs - a.waitingMs)
}

/** Open chats whose 24h customer-service window is still open, soonest to close first. */
export function openWindows(
  convs: PanelConversation[],
  states: Map<string, ThreadState>,
  now: number,
): WindowItem[] {
  const out: WindowItem[] = []
  for (const c of convs) {
    const last = states.get(c.id)?.lastCustomerAt
    if (last == null) continue
    const remainingMs = WINDOW_MS - (now - last)
    if (remainingMs > 0) out.push({ conversation: c, remainingMs })
  }
  return out.sort((a, b) => a.remainingMs - b.remainingMs)
}

export interface ColdItem {
  conversation: PanelConversation
  idleMs: number
}

/** Open chats where we spoke last and the customer has been silent for COLD_AFTER_MS+. */
export function coldConversations(
  convs: PanelConversation[],
  states: Map<string, ThreadState>,
  now: number,
): ColdItem[] {
  const out: ColdItem[] = []
  for (const c of convs) {
    const s = states.get(c.id)
    if (!s || s.lastSender === 'customer' || !c.last_message_at) continue
    const idleMs = now - new Date(c.last_message_at).getTime()
    if (idleMs >= COLD_AFTER_MS) out.push({ conversation: c, idleMs })
  }
  return out.sort((a, b) => a.idleMs - b.idleMs)
}

/**
 * Share of today's conversations (any status) where a customer wrote
 * today and someone answered after that first message. Null when no
 * customer wrote today.
 */
export function answeredTodayPct(messages: PanelMessage[], now: number): number | null {
  const today = startOfLocalDay(new Date(now)).getTime()
  const firstCustomer = new Map<string, number>()
  const answered = new Set<string>()
  for (const m of messages) {
    const ts = new Date(m.created_at).getTime()
    if (ts < today) continue
    if (m.sender_type === 'customer') {
      if (!firstCustomer.has(m.conversation_id)) firstCustomer.set(m.conversation_id, ts)
    } else if (firstCustomer.has(m.conversation_id)) {
      answered.add(m.conversation_id)
    }
  }
  if (firstCustomer.size === 0) return null
  return Math.round((answered.size / firstCustomer.size) * 100)
}

export interface ResponseSample {
  /** When the customer's first unanswered message arrived. */
  at: number
  minutes: number
  responderId: string | null
}

/** Customer message → next human (agent) reply, one sample per unanswered run. */
export function responseSamples(messages: PanelMessage[]): ResponseSample[] {
  const byConv = new Map<string, PanelMessage[]>()
  for (const m of messages) {
    const list = byConv.get(m.conversation_id)
    if (list) list.push(m)
    else byConv.set(m.conversation_id, [m])
  }
  const out: ResponseSample[] = []
  for (const list of byConv.values()) {
    let pending: number | null = null
    for (const m of list) {
      const ts = new Date(m.created_at).getTime()
      if (m.sender_type === 'customer') {
        if (pending === null) pending = ts
      } else if (m.sender_type === 'agent' && pending !== null) {
        out.push({ at: pending, minutes: (ts - pending) / 60_000, responderId: m.sender_id })
        pending = null
      }
    }
  }
  return out
}

export function median(values: number[]): number | null {
  if (values.length === 0) return null
  const s = [...values].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

export interface ResponseTrend {
  /** Median minutes for each of the last 7 local days, oldest first. */
  days: { day: number; minutes: number | null }[]
  thisWeek: number | null
  lastWeek: number | null
}

export function responseTrend(samples: ResponseSample[], now: number): ResponseTrend {
  const today = startOfLocalDay(new Date(now)).getTime()
  const DAY = 24 * 60 * 60 * 1000
  const weekStart = today - 6 * DAY
  const prevStart = weekStart - 7 * DAY
  const days = Array.from({ length: 7 }, (_, i) => {
    const from = weekStart + i * DAY
    const vals = samples.filter((s) => s.at >= from && s.at < from + DAY).map((s) => s.minutes)
    return { day: from, minutes: median(vals) }
  })
  return {
    days,
    thisWeek: median(samples.filter((s) => s.at >= weekStart).map((s) => s.minutes)),
    lastWeek: median(samples.filter((s) => s.at >= prevStart && s.at < weekStart).map((s) => s.minutes)),
  }
}

/** Sent (agent) vs received (customer) messages per local hour today. */
export function hourlyActivity(
  messages: PanelMessage[],
  now: number,
): { hour: number; sent: number; received: number }[] {
  const today = startOfLocalDay(new Date(now)).getTime()
  const hours = Array.from({ length: 24 }, (_, hour) => ({ hour, sent: 0, received: 0 }))
  for (const m of messages) {
    const d = new Date(m.created_at)
    if (d.getTime() < today) continue
    const h = hours[d.getHours()]
    if (m.sender_type === 'customer') h.received += 1
    else if (m.sender_type === 'agent') h.sent += 1
  }
  return hours
}

/** Customer messages per [mondayIndex][hour] since `since`. */
export function messageHeatmap(messages: PanelMessage[], since: number): number[][] {
  const grid = Array.from({ length: 7 }, () => Array<number>(24).fill(0))
  for (const m of messages) {
    if (m.sender_type !== 'customer') continue
    const d = new Date(m.created_at)
    if (d.getTime() < since) continue
    grid[mondayIndex(d)][d.getHours()] += 1
  }
  return grid
}

export interface AgentRanking {
  userId: string
  attended: number
  sent: number
  closed: number
  medianResponse: number | null
}

/** Per-agent month stats: chats they wrote in, messages sent, chats closed, median first reply. */
export function agentRanking(
  agentIds: string[],
  messages: PanelMessage[],
  closedByAgent: Map<string, number>,
  since: number,
): AgentRanking[] {
  const recent = messages.filter((m) => new Date(m.created_at).getTime() >= since)
  const samples = responseSamples(recent)
  return agentIds
    .map((userId) => {
      const mine = recent.filter((m) => m.sender_type === 'agent' && m.sender_id === userId)
      return {
        userId,
        attended: new Set(mine.map((m) => m.conversation_id)).size,
        sent: mine.length,
        closed: closedByAgent.get(userId) ?? 0,
        medianResponse: median(samples.filter((s) => s.responderId === userId).map((s) => s.minutes)),
      }
    })
    .sort((a, b) => b.attended - a.attended || b.sent - a.sent)
}

export interface PanelCall {
  id: string
  conversation_id: string | null
  contact_id: string | null
  direction: 'inbound' | 'outbound'
  status: 'ringing' | 'accepted' | 'ended' | 'missed' | 'rejected' | 'failed'
  ring_user_id: string | null
  answered_by: string | null
  answered_at: string | null
  created_at: string
  contact: ContactRef | null
}

const isMissedInbound = (c: PanelCall) =>
  c.direction === 'inbound' && (c.status === 'missed' || c.status === 'rejected')

/**
 * Missed inbound calls nobody has dealt with since: no later call to
 * or from that contact was answered, and no one tried calling back.
 * One row per contact (the latest miss), newest first.
 */
export function unreturnedMissedCalls(calls: PanelCall[]): PanelCall[] {
  const sorted = [...calls].sort((a, b) => a.created_at.localeCompare(b.created_at))
  const latestMiss = new Map<string, PanelCall>()
  for (const c of sorted) {
    const key = c.contact_id ?? c.conversation_id ?? c.id
    if (isMissedInbound(c)) latestMiss.set(key, c)
    else if (c.direction === 'outbound' || c.answered_at) latestMiss.delete(key)
  }
  return [...latestMiss.values()].sort((a, b) => b.created_at.localeCompare(a.created_at))
}

/** Answered vs missed calls per agent; missed calls with no ring target go under `null`. */
export function callsByAgent(calls: PanelCall[]): Map<string | null, { answered: number; missed: number }> {
  const out = new Map<string | null, { answered: number; missed: number }>()
  const bump = (k: string | null, f: 'answered' | 'missed') => {
    const row = out.get(k) ?? { answered: 0, missed: 0 }
    row[f] += 1
    out.set(k, row)
  }
  for (const c of calls) {
    if (c.answered_by) bump(c.answered_by, 'answered')
    else if (isMissedInbound(c)) bump(c.ring_user_id, 'missed')
  }
  return out
}

export interface TransferRow {
  line: string
  sent: number
  received: number
}

const TRANSFER_OUT = /^🔀 Derivado a (.+?) — tema:/u
const TRANSFER_IN = /^🔀 Derivado desde (.+?)(?: por .+?)? — tema:/u

/**
 * Line transfers, from the contact notes the transfer flow writes on
 * both sides (see src/app/api/line-transfer/route.ts and
 * buildTransferNote in src/lib/line-transfer.ts).
 */
export function transfersByLine(notes: { note_text: string }[]): TransferRow[] {
  const out = new Map<string, TransferRow>()
  const row = (line: string) => {
    const r = out.get(line) ?? { line, sent: 0, received: 0 }
    out.set(line, r)
    return r
  }
  for (const n of notes) {
    const sent = TRANSFER_OUT.exec(n.note_text)
    if (sent) {
      row(sent[1].trim()).sent += 1
      continue
    }
    const received = TRANSFER_IN.exec(n.note_text)
    if (received) row(received[1].trim()).received += 1
  }
  return [...out.values()].sort((a, b) => b.sent + b.received - (a.sent + a.received))
}
