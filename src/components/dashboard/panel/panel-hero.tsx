'use client'

import Link from 'next/link'
import type { ComponentType } from 'react'
import { useTranslations } from 'next-intl'
import { CheckCheck, Clock, Hourglass, MessageCircleWarning } from 'lucide-react'
import type { AccountRole } from '@/lib/auth/roles'
import type { PanelSummary } from '@/lib/dashboard/panel-queries'
import { cn } from '@/lib/utils'
import { Skeleton } from '@/components/dashboard/skeleton'

// The welcome card at the top of the Panel. Kept on the neutral card
// surface — the header bar above is already the line's color — with the
// line color only as an accent (avatar ring, glow, icons).

function greetingKey(hour: number) {
  if (hour < 12) return 'morning'
  if (hour < 19) return 'afternoon'
  return 'evening'
}

type KpiTone = 'critical' | 'warning' | 'brand' | 'good'

const KPI_TONE: Record<KpiTone, string> = {
  critical: 'bg-red-500/12 text-red-500',
  warning: 'bg-amber-500/15 text-amber-600',
  brand: 'bg-primary/12 text-primary',
  good: 'bg-emerald-500/12 text-emerald-600',
}

export function PanelHero({
  name,
  role,
  lineName,
  summary,
  scope,
  rangeLabel,
}: {
  name: string | null
  role: AccountRole | null
  lineName: string | null
  summary: PanelSummary | null
  scope: 'own' | 'line'
  rangeLabel: string
}) {
  const t = useTranslations('Dashboard.panel.hero')
  const now = new Date()
  const firstName = name?.trim().split(/\s+/)[0]
  const date = now.toLocaleDateString('es-PE', { weekday: 'long', day: 'numeric', month: 'long' })

  return (
    <section className="relative isolate overflow-hidden rounded-3xl border border-border bg-card px-5 pt-8 pb-5 shadow-sm sm:px-8">
      {/* A faint wash of the line color behind the greeting */}
      <span
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 -z-10 h-40"
        style={{ background: 'radial-gradient(60% 100% at 50% 0%, color-mix(in oklab, var(--primary) 14%, transparent), transparent 75%)' }}
      />

      <div className="flex flex-col items-center gap-1.5 text-center">
        <span
          className="mb-1 flex h-14 w-14 items-center justify-center rounded-full bg-primary text-xl font-black text-primary-foreground ring-4 ring-primary/20"
          aria-hidden
        >
          {firstName?.[0]?.toUpperCase() ?? '·'}
        </span>
        <h1 className="text-[26px] leading-tight font-extrabold tracking-tight text-balance text-foreground sm:text-3xl">
          {firstName ? t(`greeting.${greetingKey(now.getHours())}`, { name: firstName }) : t('greetingNoName')}
        </h1>
        <p className="flex flex-wrap items-center justify-center gap-x-2 gap-y-1 text-sm text-muted-foreground">
          {role && <span className="rounded-full bg-primary/12 px-2.5 py-0.5 text-xs font-bold text-primary">{t(`roles.${role}`)}</span>}
          {lineName && <span className="font-semibold text-foreground/80">{lineName}</span>}
          <span aria-hidden>·</span>
          <span className="capitalize">{date}</span>
        </p>
        <p className="text-xs text-muted-foreground">{scope === 'own' ? t('scopeOwn') : t('scopeLine')}</p>
      </div>

      <div className="mt-6 grid grid-cols-2 gap-3 lg:grid-cols-5">
        {summary ? (
          <>
            <Kpi icon={MessageCircleWarning} tone="critical" label={t('unanswered')} value={summary.unanswered} hint={t('conversations')} when={t('now')} />
            <Kpi icon={Hourglass} tone="warning" label={t('waitingLong')} value={summary.waitingLong} hint={t('customers')} when={t('now')} />
            <Kpi icon={Clock} tone="brand" label={t('windowsSoon')} value={summary.windowsSoon} hint={t('windowsHint')} when={t('now')} />
            <Kpi icon={CheckCheck} tone="good" label={t('closed')} value={summary.closed} hint={t('conversations')} when={rangeLabel} />
            <AnsweredRing pct={summary.answeredPct} label={t('answered')} hint={t('answeredHint')} empty={t('noMessages')} when={rangeLabel} />
          </>
        ) : (
          Array.from({ length: 5 }, (_, i) => (
            <div key={i} className={cn('rounded-2xl bg-muted/50 p-4', i === 4 && 'col-span-2 lg:col-span-1')}>
              <Skeleton className="h-3 w-24" />
              <Skeleton className="mt-3 h-8 w-14" />
            </div>
          ))
        )}
      </div>
    </section>
  )
}

function Kpi({
  icon: Icon,
  tone,
  label,
  value,
  hint,
  when,
}: {
  icon: ComponentType<{ className?: string }>
  tone: KpiTone
  label: string
  value: number
  hint: string
  when: string
}) {
  return (
    <Link
      href="/inbox"
      className="group flex flex-col gap-2 rounded-2xl border border-transparent bg-muted/50 p-4 transition-colors hover:border-border hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
    >
      <span className="flex items-center justify-between gap-2">
        <span className={cn('flex h-8 w-8 items-center justify-center rounded-lg', KPI_TONE[tone])}>
          <Icon className="h-4 w-4" />
        </span>
        <span className="truncate text-[10px] font-bold tracking-wider text-muted-foreground uppercase">{when}</span>
      </span>
      <span className="text-xs font-semibold text-muted-foreground">{label}</span>
      <span className="text-3xl leading-none font-black text-foreground tabular-nums">{value}</span>
      <span className="text-[11px] text-muted-foreground">{hint}</span>
    </Link>
  )
}

function AnsweredRing({ pct, label, hint, empty, when }: { pct: number | null; label: string; hint: string; empty: string; when: string }) {
  const r = 30
  const c = 2 * Math.PI * r
  return (
    <div className="col-span-2 flex items-center gap-4 rounded-2xl bg-muted/50 p-4 lg:col-span-1">
      <svg viewBox="0 0 76 76" className="h-[72px] w-[72px] shrink-0" role="img" aria-label={pct === null ? empty : `${label}: ${pct}%`}>
        <circle cx="38" cy="38" r={r} fill="none" stroke="var(--border)" strokeWidth="8" />
        {pct !== null && pct > 0 && (
          <circle cx="38" cy="38" r={r} fill="none" stroke="var(--primary)" strokeWidth="8" strokeLinecap="round" strokeDasharray={`${(c * pct) / 100} ${c}`} transform="rotate(-90 38 38)" />
        )}
        <text x="38" y="43" textAnchor="middle" fill="var(--foreground)" fontSize="16" fontWeight="900">
          {pct === null ? '—' : `${pct}%`}
        </text>
      </svg>
      <span className="min-w-0">
        <span className="block truncate text-[10px] font-bold tracking-wider text-muted-foreground uppercase">{when}</span>
        <span className="block text-sm font-bold text-foreground">{label}</span>
        <span className="block text-[11px] text-muted-foreground">{pct === null ? empty : hint}</span>
      </span>
    </div>
  )
}
