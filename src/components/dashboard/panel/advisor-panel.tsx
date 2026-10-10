'use client'

import { useTranslations } from 'next-intl'
import { Activity, Clock, Hourglass, Pin, PhoneMissed, Snowflake, Tag, Zap } from 'lucide-react'

import { contactName, WINDOW_MS } from '@/lib/dashboard/panel-compute'
import type { AdvisorPanelData } from '@/lib/dashboard/panel-queries'
import { HourlyChart, ResponseSparkline } from './panel-charts'
import { BarRow, Chip, ConversationRow, EmptyLine, Legend, MoreLink, PanelCard, RowList, contactSeed, useDuration } from './panel-ui'

const LIST = 5

// "Mi día" — what an Asesor needs to work their own chats today.
export function AdvisorPanel({ data }: { data: AdvisorPanelData }) {
  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
      <WindowsCard items={data.windows} />
      <WaitingCard items={data.waiting} />
      <MissedCallsCard calls={data.missedCalls} />
      <HourlyCard hours={data.hourly} className="md:col-span-2" />
      <ResponseCard trend={data.response} />
      <ColdCard items={data.cold} />
      <PinnedCard items={data.pinnedOrUnread} />
      <TagsCard tags={data.tags} />
    </div>
  )
}

function WindowsCard({ items }: { items: AdvisorPanelData['windows'] }) {
  const t = useTranslations('Dashboard.panel.windows')
  const fmt = useDuration()
  return (
    <PanelCard icon={Clock} title={t('title')} subtitle={t('subtitle')} badge={items.length ? <Chip tone="brand">{items.length}</Chip> : null}>
      {items.length === 0 ? (
        <EmptyLine text={t('empty')} />
      ) : (
        <RowList>
          {items.slice(0, LIST).map(({ conversation: c, remainingMs }) => {
            const tone = remainingMs <= 60 * 60_000 ? 'critical' : remainingMs <= 3 * 60 * 60_000 ? 'warning' : 'brand'
            const color = tone === 'critical' ? 'rgb(239 68 68)' : tone === 'warning' ? 'rgb(245 158 11)' : 'var(--primary)'
            const name = contactName(c.contact)
            return (
              <ConversationRow
                key={c.id}
                conversationId={c.id}
                seed={contactSeed(c.contact_id, name)}
                name={name}
                detail={c.last_message_text}
                end={
                  <>
                    <Chip tone={tone}>{t('left', { time: fmt(remainingMs) })}</Chip>
                    <span className="h-1.5 w-16 overflow-hidden rounded-full bg-muted">
                      <span className="block h-full rounded-full" style={{ width: `${(remainingMs / WINDOW_MS) * 100}%`, background: color }} />
                    </span>
                  </>
                }
              />
            )
          })}
          <MoreLink count={items.length - LIST} />
        </RowList>
      )}
    </PanelCard>
  )
}

function WaitingCard({ items }: { items: AdvisorPanelData['waiting'] }) {
  const t = useTranslations('Dashboard.panel.waiting')
  const fmt = useDuration()
  return (
    <PanelCard icon={Hourglass} title={t('title')} subtitle={t('subtitle')} badge={items.length ? <Chip tone={items.length ? 'critical' : 'muted'}>{items.length}</Chip> : null}>
      {items.length === 0 ? (
        <EmptyLine text={t('empty')} />
      ) : (
        <RowList>
          {items.slice(0, LIST).map(({ conversation: c, waitingMs }) => {
            const name = contactName(c.contact)
            return (
              <ConversationRow
                key={c.id}
                conversationId={c.id}
                seed={contactSeed(c.contact_id, name)}
                name={name}
                detail={c.last_message_text}
                end={<Chip tone={waitingMs > 30 * 60_000 ? 'critical' : 'warning'}>{fmt(waitingMs)}</Chip>}
              />
            )
          })}
          <MoreLink count={items.length - LIST} />
        </RowList>
      )}
    </PanelCard>
  )
}

function MissedCallsCard({ calls }: { calls: AdvisorPanelData['missedCalls'] }) {
  const t = useTranslations('Dashboard.panel.missedCalls')
  const when = (iso: string) => {
    const d = new Date(iso)
    const today = new Date()
    const time = d.toLocaleTimeString('es-PE', { hour: '2-digit', minute: '2-digit' })
    if (d.toDateString() === today.toDateString()) return t('today', { time })
    return `${d.toLocaleDateString('es-PE', { weekday: 'short', day: 'numeric' })} · ${time}`
  }
  return (
    <PanelCard icon={PhoneMissed} title={t('title')} subtitle={t('subtitle')} badge={calls.length ? <Chip tone="critical">{calls.length}</Chip> : null}>
      {calls.length === 0 ? (
        <EmptyLine text={t('empty')} />
      ) : (
        <RowList>
          {calls.slice(0, LIST).map((c) => {
            const name = contactName(c.contact)
            return (
              <ConversationRow
                key={c.id}
                conversationId={c.conversation_id}
                seed={contactSeed(c.contact_id, name)}
                name={name}
                detail={when(c.created_at)}
                end={<span className="rounded-lg bg-primary px-2.5 py-1 text-xs font-bold text-primary-foreground">{t('callBack')}</span>}
              />
            )
          })}
        </RowList>
      )}
    </PanelCard>
  )
}

function HourlyCard({ hours, className }: { hours: AdvisorPanelData['hourly']; className?: string }) {
  const t = useTranslations('Dashboard.panel.hourly')
  const sent = hours.reduce((s, h) => s + h.sent, 0)
  const received = hours.reduce((s, h) => s + h.received, 0)
  return (
    <PanelCard icon={Activity} title={t('title')} subtitle={t('subtitle')} className={className}>
      <div className="flex flex-wrap gap-8">
        <div>
          <p className="text-3xl leading-none font-black text-primary tabular-nums">{sent}</p>
          <p className="mt-1 text-xs text-muted-foreground">{t('sentToday')}</p>
        </div>
        <div>
          <p className="text-3xl leading-none font-black text-foreground tabular-nums">{received}</p>
          <p className="mt-1 text-xs text-muted-foreground">{t('receivedToday')}</p>
        </div>
      </div>
      {sent + received === 0 ? <EmptyLine text={t('empty')} /> : <HourlyChart hours={hours} />}
      <Legend items={[{ label: t('sent'), color: 'var(--primary)' }, { label: t('received'), color: 'var(--muted-foreground)' }]} />
    </PanelCard>
  )
}

function ResponseCard({ trend }: { trend: AdvisorPanelData['response'] }) {
  const t = useTranslations('Dashboard.panel.response')
  const fmt = (m: number) => (m < 60 ? t('minutes', { n: Math.round(m) }) : t('hours', { n: (m / 60).toFixed(1) }))
  const diff = trend.current !== null && trend.previous !== null ? trend.current - trend.previous : null
  return (
    <PanelCard icon={Zap} title={t('title')} subtitle={t('subtitle')}>
      {trend.current === null ? (
        <EmptyLine text={t('empty')} />
      ) : (
        <>
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <p className="text-4xl leading-none font-black text-foreground tabular-nums">{fmt(trend.current)}</p>
              <p className="mt-1 text-xs text-muted-foreground">{t('thisWeek')}</p>
            </div>
            {diff !== null && Math.abs(diff) >= 0.5 && (
              <Chip tone={diff < 0 ? 'good' : 'warning'}>
                {diff < 0 ? '▼' : '▲'} {t('vsLastWeek', { time: fmt(Math.abs(diff)) })}
              </Chip>
            )}
          </div>
          <ResponseSparkline days={trend.days} />
        </>
      )}
    </PanelCard>
  )
}

function ColdCard({ items }: { items: AdvisorPanelData['cold'] }) {
  const t = useTranslations('Dashboard.panel.cold')
  const fmt = useDuration()
  return (
    <PanelCard icon={Snowflake} title={t('title')} subtitle={t('subtitle')} badge={items.length ? <Chip tone="warning">{items.length}</Chip> : null}>
      {items.length === 0 ? (
        <EmptyLine text={t('empty')} />
      ) : (
        <RowList>
          {items.slice(0, LIST).map(({ conversation: c, idleMs }) => {
            const name = contactName(c.contact)
            return (
              <ConversationRow
                key={c.id}
                conversationId={c.id}
                seed={contactSeed(c.contact_id, name)}
                name={name}
                detail={c.last_message_text ? t('last', { text: c.last_message_text }) : null}
                end={<Chip tone="warning">{fmt(idleMs)}</Chip>}
              />
            )
          })}
          <MoreLink count={items.length - LIST} />
        </RowList>
      )}
    </PanelCard>
  )
}

function PinnedCard({ items }: { items: AdvisorPanelData['pinnedOrUnread'] }) {
  const t = useTranslations('Dashboard.panel.pinned')
  return (
    <PanelCard icon={Pin} title={t('title')} subtitle={t('subtitle')}>
      {items.length === 0 ? (
        <EmptyLine text={t('empty')} />
      ) : (
        <RowList>
          {items.slice(0, LIST + 1).map(({ conversation: c, pinned }) => {
            const name = contactName(c.contact)
            const unread = c.unread_count ?? 0
            return (
              <ConversationRow
                key={c.id}
                conversationId={c.id}
                seed={contactSeed(c.contact_id, name)}
                name={name}
                detail={c.last_message_text}
                end={
                  <>
                    {pinned && <Chip tone="brand">{t('pinnedChip')}</Chip>}
                    {unread > 0 && <Chip tone="critical">{t('unread', { n: unread })}</Chip>}
                  </>
                }
              />
            )
          })}
        </RowList>
      )}
    </PanelCard>
  )
}

function TagsCard({ tags }: { tags: AdvisorPanelData['tags'] }) {
  const t = useTranslations('Dashboard.panel.tags')
  const max = tags[0]?.count ?? 0
  return (
    <PanelCard icon={Tag} title={t('title')} subtitle={t('subtitle')}>
      {tags.length === 0 ? (
        <EmptyLine text={t('empty')} />
      ) : (
        <>
          <div className="flex flex-wrap gap-2">
            {tags.slice(0, 10).map((tag) => (
              <span
                key={tag.id}
                className="inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-sm font-semibold"
                style={{ background: `color-mix(in oklab, ${tag.color} 16%, transparent)`, color: `color-mix(in oklab, ${tag.color} 80%, var(--foreground))` }}
              >
                <span className="h-2 w-2 rounded-full" style={{ background: tag.color }} />
                {tag.name}
                <span className="tabular-nums opacity-75">{tag.count}</span>
              </span>
            ))}
          </div>
          <div className="flex flex-col gap-2.5">
            {tags.slice(0, 4).map((tag) => (
              <BarRow key={tag.id} label={tag.name} segments={[{ value: tag.count, color: tag.color }]} max={max} value={tag.count} />
            ))}
          </div>
        </>
      )}
    </PanelCard>
  )
}
