'use client'

import { useTranslations } from 'next-intl'
import { ArrowLeftRight, CalendarClock, Inbox, PhoneCall, Trophy, Users } from 'lucide-react'

import { contactName } from '@/lib/dashboard/panel-compute'
import type { SupervisorPanelData } from '@/lib/dashboard/panel-queries'
import { usePresence } from '@/hooks/use-presence'
import { cn } from '@/lib/utils'
import { Heatmap } from './panel-charts'
import { BarRow, Chip, ConversationRow, EmptyLine, Initials, Legend, MoreLink, PanelCard, RowList, brandMix, contactSeed, useDuration } from './panel-ui'

const MISSED = 'rgb(239 68 68)'

// "Supervisión" — ATC, jefe de línea, gerencia and administración see
// the whole line: how the team is doing and what needs assigning.
export function SupervisorPanel({ data }: { data: SupervisorPanelData }) {
  const names = new Map(data.agents.map((a) => [a.userId, a.name]))
  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
      <RankingCard data={data} className="md:col-span-2" />
      <QueueCard queue={data.queue} now={data.loadedAt} />
      <LoadCard data={data} />
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
                const name = agents.get(r.userId)?.name ?? '—'
                return (
                  <tr key={r.userId} className="border-t border-border">
                    <td className="px-2 py-2.5">
                      <span className="flex items-center gap-2.5 font-semibold text-foreground">
                        <span
                          className={cn('flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-[11px] font-black tabular-nums', i === 0 ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground')}
                        >
                          {i + 1}
                        </span>
                        <Initials seed={r.userId} name={name} className="h-8 w-8" />
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

function QueueCard({ queue, now }: { queue: SupervisorPanelData['queue']; now: number }) {
  const t = useTranslations('Dashboard.panel.queue')
  const fmt = useDuration()
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
                end={<span className="rounded-lg bg-primary px-2.5 py-1 text-xs font-bold text-primary-foreground">{t('assign')}</span>}
              />
            )
          })}
          <MoreLink count={queue.length - 4} />
        </RowList>
      )}
    </PanelCard>
  )
}

const PRESENCE_COLOR = { online: 'rgb(16 185 129)', away: 'rgb(245 158 11)', offline: 'var(--muted-foreground)' } as const

function LoadCard({ data }: { data: SupervisorPanelData }) {
  const t = useTranslations('Dashboard.panel.load')
  const { getPresence } = usePresence()
  const rows = data.agents
    .map((a) => ({ ...a, open: data.openByAgent.get(a.userId) ?? 0, presence: getPresence(a.userId) }))
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
