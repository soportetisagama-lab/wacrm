'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { ArrowLeftRight, CalendarClock, ChevronDown, Inbox, PhoneCall, Trophy, Users } from 'lucide-react'
import { toast } from 'sonner'

import { contactName } from '@/lib/dashboard/panel-compute'
import type { SupervisorPanelData } from '@/lib/dashboard/panel-queries'
import { assignConversation } from '@/lib/conversations/assign'
import { createClient } from '@/lib/supabase/client'
import { useAuth } from '@/hooks/use-auth'
import { usePresence } from '@/hooks/use-presence'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'
import { Heatmap } from './panel-charts'
import { BarRow, Chip, ConversationRow, EmptyLine, Initials, Legend, MoreLink, PanelCard, RowList, brandMix, contactSeed, useDuration } from './panel-ui'

const MISSED = 'rgb(239 68 68)'
const PRESENCE_COLOR = { online: 'rgb(16 185 129)', away: 'rgb(245 158 11)', offline: 'var(--muted-foreground)' } as const

type GetPresence = ReturnType<typeof usePresence>['getPresence']

// "Supervisión" — ATC, jefe de línea, gerencia and administración see
// the whole line: how the team is doing and what needs assigning.
export function SupervisorPanel({ data, onRefresh }: { data: SupervisorPanelData; onRefresh: () => void }) {
  const names = new Map(data.agents.map((a) => [a.userId, a.name]))
  const { getPresence } = usePresence()

  // Assignments made here apply on top of `data` until a snapshot started
  // after them arrives: one already loading (the panel refreshes every
  // minute) would otherwise put the row back in the queue.
  const [assigned, setAssigned] = useState<Map<string, { agentId: string; at: number }>>(() => new Map())
  const pending = [...assigned.entries()].filter(([, a]) => a.at > data.loadedAt)
  const pendingIds = new Set(pending.map(([id]) => id))
  const queue = data.queue.filter((c) => !pendingIds.has(c.id))
  const openByAgent = new Map(data.openByAgent)
  for (const [id, a] of pending) {
    // Only rows this snapshot still counts as unassigned.
    if (data.queue.some((c) => c.id === id)) openByAgent.set(a.agentId, (openByAgent.get(a.agentId) ?? 0) + 1)
  }

  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
      <RankingCard data={data} className="md:col-span-2" />
      <QueueCard
        queue={queue}
        now={data.loadedAt}
        agents={data.agents}
        getPresence={getPresence}
        onAssigned={(id, agentId) => setAssigned((prev) => new Map(prev).set(id, { agentId, at: Date.now() }))}
        onStale={onRefresh}
      />
      <LoadCard data={data} openByAgent={openByAgent} getPresence={getPresence} />
      <HeatmapCard grid={data.heatmap} className="md:col-span-1 xl:col-span-2" />
      <CallsCard calls={data.calls} names={names} className="xl:col-span-2" />
      <TransfersCard rows={data.transfers} />
    </div>
  )
}

function RankingCard({ data, className }: { data: SupervisorPanelData; className?: string }) {
  const t = useTranslations('Dashboard.panel.ranking')
  const agents = new Map(data.agents.map((a) => [a.userId, a]))
  const max = Math.max(1, ...data.ranking.map((r) => r.attended))
  const fmtMin = (m: number | null) => (m === null ? '—' : m < 60 ? `${Math.round(m)} min` : `${(m / 60).toFixed(1)} h`)
  return (
    <PanelCard icon={Trophy} title={t('title')} subtitle={t('subtitle')} className={className}>
      {data.ranking.length === 0 ? (
        <EmptyLine text={t('empty')} />
      ) : (
        <div className="-mx-1 overflow-x-auto">
          <table className="w-full min-w-[520px] text-sm">
            <thead>
              <tr className="text-[11px] font-bold tracking-wider text-muted-foreground uppercase">
                <th className="px-2 pb-2 text-left">{t('agent')}</th>
                <th className="px-2 pb-2 text-right">{t('attended')}</th>
                <th className="px-2 pb-2 text-right">{t('firstReply')}</th>
                <th className="px-2 pb-2 text-right">{t('closed')}</th>
                <th className="px-2 pb-2 text-right">{t('sent')}</th>
              </tr>
            </thead>
            <tbody>
              {data.ranking.map((r, i) => {
                const agent = agents.get(r.userId)
                const name = agent?.name ?? '—'
                return (
                  <tr key={r.userId} className="border-t border-border">
                    <td className="px-2 py-2.5">
                      <span className="flex items-center gap-2.5 font-semibold text-foreground">
                        <span
                          className={cn('flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-[11px] font-black tabular-nums', i === 0 ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground')}
                        >
                          {i + 1}
                        </span>
                        <Initials seed={r.userId} name={name} avatarUrl={agent?.avatarUrl} className="h-8 w-8" />
                        <span className="truncate">{name}</span>
                      </span>
                    </td>
                    <td className="px-2 py-2.5 text-right tabular-nums">
                      <span className="inline-flex items-center gap-2">
                        <span className="hidden h-1.5 rounded-full sm:inline-block" style={{ width: `${(r.attended / max) * 56}px`, background: 'var(--primary)' }} />
                        <b>{r.attended}</b>
                      </span>
                    </td>
                    <td className="px-2 py-2.5 text-right tabular-nums">{fmtMin(r.medianResponse)}</td>
                    <td className="px-2 py-2.5 text-right tabular-nums">{r.closed}</td>
                    <td className="px-2 py-2.5 text-right tabular-nums">{r.sent.toLocaleString('es-PE')}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </PanelCard>
  )
}

function AssignMenu({
  conversation,
  agents,
  getPresence,
  onAssigned,
  onStale,
}: {
  conversation: SupervisorPanelData['queue'][number]
  agents: SupervisorPanelData['agents']
  getPresence: GetPresence
  onAssigned: (conversationId: string, agentId: string) => void
  onStale: () => void
}) {
  const t = useTranslations('Dashboard.panel.queue')
  const { user } = useAuth()
  const [busy, setBusy] = useState(false)
  const name = contactName(conversation.contact)

  const assign = async (agent: SupervisorPanelData['agents'][number]) => {
    setBusy(true)
    const result = await assignConversation(createClient(), {
      conversationId: conversation.id,
      agentId: agent.userId,
      currentUserId: user?.id,
      currentUnread: conversation.unread_count,
      onlyIfUnassigned: true,
    })
    setBusy(false)
    if (result.ok) {
      toast.success(t('assigned', { name: agent.name }))
      onAssigned(conversation.id, agent.userId)
    } else if (result.reason === 'already_assigned') {
      // Assigned by someone else, or no longer writable: the snapshot is old.
      toast.error(t('alreadyAssigned'))
      onStale()
    } else {
      console.error('[panel] assign failed:', result.error)
      toast.error(t('assignFailed'))
    }
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        disabled={busy}
        aria-label={t('assignAria', { name })}
        className="inline-flex items-center gap-1 rounded-lg bg-primary px-2.5 py-1 text-xs font-bold text-primary-foreground transition-opacity hover:opacity-90 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:opacity-60"
      >
        {t('assign')}
        <ChevronDown className="h-3 w-3" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="max-h-72 w-56 border-border bg-popover">
        {agents.length === 0 ? (
          <DropdownMenuItem disabled className="text-sm text-muted-foreground">
            {t('noAgents')}
          </DropdownMenuItem>
        ) : (
          agents.map((a) => (
            <DropdownMenuItem key={a.userId} onClick={() => void assign(a)} className="text-sm text-popover-foreground">
              <span className="mr-2 h-2 w-2 shrink-0 rounded-full" style={{ background: PRESENCE_COLOR[getPresence(a.userId)] }} aria-hidden />
              <span className="truncate">{a.name}</span>
            </DropdownMenuItem>
          ))
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function QueueCard({
  queue,
  now,
  agents,
  getPresence,
  onAssigned,
  onStale,
}: {
  queue: SupervisorPanelData['queue']
  now: number
  agents: SupervisorPanelData['agents']
  getPresence: GetPresence
  onAssigned: (conversationId: string, agentId: string) => void
  onStale: () => void
}) {
  const t = useTranslations('Dashboard.panel.queue')
  const fmt = useDuration()
  // Every role but the Asesor sees this panel, including read-only ones.
  const { canAssignConversations } = useAuth()
  const oldest = queue[0]
  return (
    <PanelCard icon={Inbox} title={t('title')} subtitle={t('subtitle')}>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className={cn('text-5xl leading-none font-black tabular-nums', queue.length ? 'text-red-500' : 'text-emerald-600')}>{queue.length}</p>
          <p className="mt-1 text-xs text-muted-foreground">{t('count')}</p>
        </div>
        {oldest && <Chip tone="critical">{t('oldest', { time: fmt(now - new Date(oldest.created_at).getTime()) })}</Chip>}
      </div>
      {queue.length === 0 ? (
        <EmptyLine text={t('empty')} />
      ) : (
        <RowList>
          {queue.slice(0, 4).map((c) => {
            const name = contactName(c.contact)
            return (
              <ConversationRow
                key={c.id}
                conversationId={c.id}
                seed={contactSeed(c.contact_id, name)}
                name={name}
                detail={t('since', { time: fmt(now - new Date(c.created_at).getTime()) })}
                action={
                  canAssignConversations ? (
                    <AssignMenu conversation={c} agents={agents} getPresence={getPresence} onAssigned={onAssigned} onStale={onStale} />
                  ) : undefined
                }
              />
            )
          })}
          <MoreLink count={queue.length - 4} href="/inbox?asesor=sin-asignar" />
        </RowList>
      )}
    </PanelCard>
  )
}

function LoadCard({
  data,
  openByAgent,
  getPresence,
}: {
  data: SupervisorPanelData
  openByAgent: Map<string, number>
  getPresence: GetPresence
}) {
  const t = useTranslations('Dashboard.panel.load')
  const rows = data.agents
    .map((a) => ({ ...a, open: openByAgent.get(a.userId) ?? 0, presence: getPresence(a.userId) }))
    .sort((a, b) => b.open - a.open)
  const max = Math.max(1, ...rows.map((r) => r.open))
  const online = rows.filter((r) => r.presence === 'online').length
  return (
    <PanelCard icon={Users} title={t('title')} subtitle={t('subtitle')} badge={<Chip tone="good">{t('online', { n: online })}</Chip>}>
      {rows.length === 0 ? (
        <EmptyLine text={t('empty')} />
      ) : (
        <>
          <div className="flex flex-col gap-3">
            {rows.map((r) => (
              <BarRow
                key={r.userId}
                label={r.name}
                lead={<span className="h-2 w-2 shrink-0 rounded-full" style={{ background: PRESENCE_COLOR[r.presence] }} />}
                segments={[{ value: r.open, color: `linear-gradient(90deg, var(--primary), ${brandMix(65, 'white')})` }]}
                max={max}
                value={r.open}
                title={`${r.name}: ${t('openN', { n: r.open })} · ${t(`presence.${r.presence}`)}`}
              />
            ))}
          </div>
          <Legend
            items={[
              { label: t('presence.online'), color: PRESENCE_COLOR.online },
              { label: t('presence.away'), color: PRESENCE_COLOR.away },
              { label: t('presence.offline'), color: PRESENCE_COLOR.offline },
            ]}
          />
        </>
      )}
    </PanelCard>
  )
}

function HeatmapCard({ grid, className }: { grid: number[][]; className?: string }) {
  const t = useTranslations('Dashboard.panel.heatmap')
  const total = grid.flat().reduce((a, b) => a + b, 0)
  return (
    <PanelCard icon={CalendarClock} title={t('title')} subtitle={t('subtitle')} className={className}>
      {total === 0 ? <EmptyLine text={t('empty')} /> : <Heatmap grid={grid} />}
    </PanelCard>
  )
}

function CallsCard({
  calls,
  names,
  className,
}: {
  calls: SupervisorPanelData['calls']
  names: Map<string, string>
  className?: string
}) {
  const t = useTranslations('Dashboard.panel.calls')
  const rows = [...calls.entries()]
    .map(([userId, v]) => ({ key: userId ?? 'none', name: userId ? (names.get(userId) ?? t('otherMember')) : t('unassigned'), ...v }))
    .sort((a, b) => b.answered + b.missed - (a.answered + a.missed))
  const max = Math.max(1, ...rows.map((r) => r.answered + r.missed))
  const answered = rows.reduce((s, r) => s + r.answered, 0)
  const missed = rows.reduce((s, r) => s + r.missed, 0)
  return (
    <PanelCard icon={PhoneCall} title={t('title')} subtitle={t('subtitle')} className={className}>
      <div className="flex flex-wrap gap-8">
        <div>
          <p className="text-3xl leading-none font-black text-primary tabular-nums">{answered}</p>
          <p className="mt-1 text-xs text-muted-foreground">{t('answered')}</p>
        </div>
        <div>
          <p className="text-3xl leading-none font-black text-red-500 tabular-nums">{missed}</p>
          <p className="mt-1 text-xs text-muted-foreground">{t('missed')}</p>
        </div>
      </div>
      {rows.length === 0 ? (
        <EmptyLine text={t('empty')} />
      ) : (
        <>
          <div className={cn('flex flex-col gap-3', className && 'xl:grid xl:grid-cols-2 xl:gap-x-8')}>
            {rows.map((r) => (
              <BarRow
                key={r.key}
                label={r.name}
                segments={[
                  { value: r.answered, color: 'var(--primary)' },
                  { value: r.missed, color: MISSED },
                ]}
                max={max}
                value={r.answered + r.missed}
                title={`${r.name}: ${t('answeredN', { n: r.answered })} · ${t('missedN', { n: r.missed })}`}
              />
            ))}
          </div>
          <Legend items={[{ label: t('answered'), color: 'var(--primary)' }, { label: t('missed'), color: MISSED }]} />
        </>
      )}
    </PanelCard>
  )
}

function TransfersCard({ rows }: { rows: SupervisorPanelData['transfers'] }) {
  const t = useTranslations('Dashboard.panel.transfers')
  const max = Math.max(1, ...rows.map((r) => r.sent + r.received))
  const label = (line: string) => line.replace(/^Sagama\s+/i, '')
  return (
    <PanelCard icon={ArrowLeftRight} title={t('title')} subtitle={t('subtitle')}>
      {rows.length === 0 ? (
        <EmptyLine text={t('empty')} />
      ) : (
        <>
          <div className="flex flex-col gap-3">
            {rows.map((r) => (
              <BarRow
                key={r.line}
                label={label(r.line)}
                segments={[
                  { value: r.sent, color: 'var(--primary)' },
                  { value: r.received, color: brandMix(35, 'var(--muted)') },
                ]}
                max={max}
                value={r.sent + r.received}
                title={`${label(r.line)}: ${t('sentN', { n: r.sent })} · ${t('receivedN', { n: r.received })}`}
              />
            ))}
          </div>
          <Legend items={[{ label: t('sent'), color: 'var(--primary)' }, { label: t('received'), color: brandMix(35, 'var(--muted)') }]} />
        </>
      )}
    </PanelCard>
  )
}
