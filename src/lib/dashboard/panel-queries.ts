import type { SupabaseClient } from '@supabase/supabase-js'
import type { AccountRole } from '@/lib/auth/roles'
import { daysAgoStart } from './date-utils'
import {
  agentRanking,
  answeredPct,
  callsByAgent,
  coldConversations,
  hourlyActivity,
  messageHeatmap,
  openWindows,
  responseSamples,
  responseTrend,
  threadStates,
  transfersByLine,
  unreturnedMissedCalls,
  waitingConversations,
  WAIT_ALERT_MS,
  WINDOW_SOON_MS,
  type AgentRanking,
  type ColdItem,
  type ContactRef,
  type PanelCall,
  type PanelConversation,
  type PanelMessage,
  type PanelRange,
  type ResponseTrend,
  type TransferRow,
  type WaitingItem,
  type WindowItem,
} from './panel-compute'

// ------------------------------------------------------------
// Reads for the role-based Panel. RLS does the scoping: an Asesor
// (agent) only gets back the conversations assigned to them — and their
// messages and calls — while every other role sees the whole line. So
// the same queries serve both views; only which widgets render differs.
//
// PostgREST caps a response at 1000 rows, so anything that can grow past
// that is paged (fetchAll / fetchAllParallel).
// ------------------------------------------------------------

type DB = SupabaseClient

const PAGE = 1000

interface Page<T> {
  data: T[] | null
  error: unknown
  count?: number | null
}
interface Rangeable<T> {
  range: (from: number, to: number) => PromiseLike<Page<T>>
}

async function fetchAll<T>(make: () => Rangeable<T>, max = 20_000): Promise<T[]> {
  const out: T[] = []
  for (let from = 0; from < max; from += PAGE) {
    const { data, error } = await make().range(from, from + PAGE - 1)
    if (error) throw error
    out.push(...(data ?? []))
    if (!data || data.length < PAGE) break
  }
  return out
}

/** Like fetchAll, but asks for the row count first and loads the pages in parallel. */
async function fetchAllParallel<T>(
  count: () => PromiseLike<Page<unknown>>,
  make: () => Rangeable<T>,
  max = 60_000,
): Promise<T[]> {
  const head = await count()
  if (head.error) throw head.error
  const total = Math.min(head.count ?? 0, max)
  const pages = await Promise.all(
    Array.from({ length: Math.ceil(total / PAGE) }, (_, i) => make().range(i * PAGE, i * PAGE + PAGE - 1)),
  )
  const out: T[] = []
  for (const p of pages) {
    if (p.error) throw p.error
    out.push(...(p.data ?? []))
  }
  return out
}

const one = <T>(v: T | T[] | null | undefined): T | null => (Array.isArray(v) ? (v[0] ?? null) : (v ?? null))

const CONV_COLUMNS =
  'id, contact_id, status, assigned_agent_id, last_message_at, last_message_text, unread_count, created_at, contact:contacts(name, phone, whatsapp_user_id)'

type RawConversation = Omit<PanelConversation, 'contact'> & { contact: ContactRef | ContactRef[] | null }
const toConversation = (r: RawConversation): PanelConversation => ({ ...r, contact: one(r.contact) })

function loadOpenConversations(db: DB): Promise<PanelConversation[]> {
  return fetchAll<RawConversation>(() =>
    db.from('conversations').select(CONV_COLUMNS).in('status', ['open', 'pending']).order('id'),
  ).then((rows) => rows.map(toConversation))
}

function loadMessages(db: DB, since: Date): Promise<PanelMessage[]> {
  const iso = since.toISOString()
  return fetchAllParallel<PanelMessage>(
    () => db.from('messages').select('id', { count: 'exact', head: true }).gte('created_at', iso),
    () =>
      db
        .from('messages')
        .select('conversation_id, sender_type, sender_id, created_at')
        .gte('created_at', iso)
        .order('created_at', { ascending: true })
        .order('id', { ascending: true }),
  )
}

async function countClosed(db: DB, range: PanelRange): Promise<number> {
  const { count, error } = await db
    .from('conversations')
    .select('id', { count: 'exact', head: true })
    .eq('status', 'closed')
    .gte('updated_at', new Date(range.from).toISOString())
    .lt('updated_at', new Date(range.to).toISOString())
  if (error) throw error
  return count ?? 0
}

type RawCall = Omit<PanelCall, 'contact'> & { contact: ContactRef | ContactRef[] | null }

function loadCalls(db: DB, since: Date): Promise<PanelCall[]> {
  return fetchAll<RawCall>(() =>
    db
      .from('whatsapp_calls')
      .select(
        'id, conversation_id, contact_id, direction, status, ring_user_id, answered_by, answered_at, created_at, contact:contacts(name, phone, whatsapp_user_id)',
      )
      .gte('created_at', since.toISOString())
      .order('created_at', { ascending: true }),
  ).then((rows) => rows.map((r) => ({ ...r, contact: one(r.contact) })))
}

/** Live chat state (waiting, windows, gone quiet) needs ~30 days of history whatever the range. */
const messagesSince = (from: number) => new Date(Math.min(from, daysAgoStart(30).getTime()))

// ── Summary strip (both views) ─────────────────────────────

export interface PanelSummary {
  /** Live counts — always "right now", whatever the range. */
  unanswered: number
  waitingLong: number
  windowsSoon: number
  /** Range counts. */
  closed: number
  answeredPct: number | null
}

function summarize(
  waiting: WaitingItem[],
  windows: WindowItem[],
  messages: PanelMessage[],
  closed: number,
  range: PanelRange,
): PanelSummary {
  return {
    unanswered: waiting.length,
    waitingLong: waiting.filter((w) => w.waitingMs >= WAIT_ALERT_MS).length,
    windowsSoon: windows.filter((w) => w.remainingMs <= WINDOW_SOON_MS).length,
    closed,
    answeredPct: answeredPct(messages, range),
  }
}

// ── Asesor ─────────────────────────────────────────────────

export interface TagCount {
  id: string
  name: string
  color: string
  count: number
}

export interface PinnedOrUnread {
  conversation: PanelConversation
  pinned: boolean
}

export interface AdvisorPanelData {
  summary: PanelSummary
  windows: WindowItem[]
  waiting: WaitingItem[]
  missedCalls: PanelCall[]
  cold: ColdItem[]
  response: ResponseTrend
  hourly: { hour: number; sent: number; received: number }[]
  tags: TagCount[]
  pinnedOrUnread: PinnedOrUnread[]
}

async function loadTagCounts(db: DB): Promise<TagCount[]> {
  // Contacts behind the conversations this user can see (RLS).
  const rows = await fetchAll<{ contact_id: string }>(() =>
    db.from('conversations').select('contact_id').order('id'),
  )
  const contactIds = [...new Set(rows.map((r) => r.contact_id))]
  const counts = new Map<string, TagCount>()
  for (let i = 0; i < contactIds.length; i += 150) {
    const chunk = contactIds.slice(i, i + 150)
    const tagged = await fetchAll<{ tag: { id: string; name: string; color: string } | { id: string; name: string; color: string }[] | null }>(() =>
      db.from('contact_tags').select('tag:tags(id, name, color)').in('contact_id', chunk).order('id'),
    )
    for (const r of tagged) {
      const tag = one(r.tag)
      if (!tag) continue
      const row = counts.get(tag.id) ?? { ...tag, count: 0 }
      row.count += 1
      counts.set(tag.id, row)
    }
  }
  return [...counts.values()].sort((a, b) => b.count - a.count)
}

async function loadPinnedOrUnread(db: DB, userId: string, open: PanelConversation[]): Promise<PinnedOrUnread[]> {
  const { data, error } = await db
    .from('conversation_pins')
    .select(`pinned_at, conversation:conversations(${CONV_COLUMNS})`)
    .eq('user_id', userId)
    .order('pinned_at', { ascending: false })
  if (error) throw error
  const pinned = ((data ?? []) as { conversation: RawConversation | RawConversation[] | null }[])
    .map((r) => one(r.conversation))
    .filter((c): c is RawConversation => !!c)
    .map(toConversation)
  const pinnedIds = new Set(pinned.map((c) => c.id))
  const unread = open
    .filter((c) => (c.unread_count ?? 0) > 0 && !pinnedIds.has(c.id))
    .sort((a, b) => (b.last_message_at ?? '').localeCompare(a.last_message_at ?? ''))
  return [...pinned.map((conversation) => ({ conversation, pinned: true })), ...unread.map((conversation) => ({ conversation, pinned: false }))]
}

export async function loadAdvisorPanel(db: DB, userId: string, range: PanelRange): Promise<AdvisorPanelData> {
  const now = Date.now()
  // The response card compares against the same-length period before the range.
  const previousFrom = range.from - (range.to - range.from)
  const [open, messages, closed, calls, tags] = await Promise.all([
    loadOpenConversations(db),
    loadMessages(db, messagesSince(previousFrom)),
    countClosed(db, range),
    loadCalls(db, new Date(range.from)),
    loadTagCounts(db),
  ])
  const states = threadStates(messages)
  const waiting = waitingConversations(open, states, now)
  const windows = openWindows(open, states, now)
  return {
    summary: summarize(waiting, windows, messages, closed, range),
    windows,
    waiting,
    missedCalls: unreturnedMissedCalls(calls, range),
    cold: coldConversations(open, states, now),
    response: responseTrend(responseSamples(messages), range),
    hourly: hourlyActivity(messages, range),
    tags,
    pinnedOrUnread: await loadPinnedOrUnread(db, userId, open),
  }
}

// ── Supervisión ────────────────────────────────────────────

export interface TeamMember {
  userId: string
  name: string
  role: AccountRole
  avatarUrl: string | null
}

export interface SupervisorPanelData {
  /** When this snapshot was computed — ages in the UI are measured from it. */
  loadedAt: number
  summary: PanelSummary
  agents: TeamMember[]
  ranking: AgentRanking[]
  queue: PanelConversation[]
  openByAgent: Map<string, number>
  heatmap: number[][]
  calls: Map<string | null, { answered: number; missed: number }>
  transfers: TransferRow[]
}

export async function loadSupervisorPanel(db: DB, range: PanelRange): Promise<SupervisorPanelData> {
  const now = Date.now()
  const fromIso = new Date(range.from).toISOString()
  const toIso = new Date(range.to).toISOString()

  const [open, messages, closed, closedRows, calls, profiles, notes] = await Promise.all([
    loadOpenConversations(db),
    loadMessages(db, messagesSince(range.from)),
    countClosed(db, range),
    fetchAll<{ assigned_agent_id: string | null }>(() =>
      db
        .from('conversations')
        .select('assigned_agent_id')
        .eq('status', 'closed')
        .gte('updated_at', fromIso)
        .lt('updated_at', toIso)
        .order('id'),
    ),
    loadCalls(db, new Date(range.from)),
    db.from('profiles').select('user_id, full_name, account_role, avatar_url'),
    fetchAll<{ note_text: string }>(() =>
      db
        .from('contact_notes')
        .select('note_text')
        .like('note_text', '🔀 Derivado%')
        .gte('created_at', fromIso)
        .lt('created_at', toIso)
        .order('created_at'),
    ),
  ])
  if (profiles.error) throw profiles.error

  const members = ((profiles.data ?? []) as { user_id: string; full_name: string | null; account_role: AccountRole; avatar_url: string | null }[])
    .map((p) => ({ userId: p.user_id, name: p.full_name || 'Sin nombre', role: p.account_role, avatarUrl: p.avatar_url }))
  const agents = members.filter((m) => m.role === 'agent').sort((a, b) => a.name.localeCompare(b.name, 'es'))

  const closedByAgent = new Map<string, number>()
  for (const r of closedRows) {
    if (r.assigned_agent_id) closedByAgent.set(r.assigned_agent_id, (closedByAgent.get(r.assigned_agent_id) ?? 0) + 1)
  }
  const openByAgent = new Map<string, number>()
  for (const c of open) {
    if (c.assigned_agent_id) openByAgent.set(c.assigned_agent_id, (openByAgent.get(c.assigned_agent_id) ?? 0) + 1)
  }

  const states = threadStates(messages)
  const waiting = waitingConversations(open, states, now)
  const windows = openWindows(open, states, now)
  return {
    loadedAt: now,
    summary: summarize(waiting, windows, messages, closed, range),
    agents,
    ranking: agentRanking(agents.map((a) => a.userId), messages, closedByAgent, range),
    queue: open
      .filter((c) => !c.assigned_agent_id)
      .sort((a, b) => a.created_at.localeCompare(b.created_at)),
    openByAgent,
    heatmap: messageHeatmap(messages, range),
    calls: callsByAgent(calls.filter((c) => c.created_at < toIso)),
    transfers: transfersByLine(notes),
  }
}
