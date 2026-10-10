'use client'

import Link from 'next/link'
import { useTranslations } from 'next-intl'
import type { AccountRole } from '@/lib/auth/roles'
import type { PanelSummary } from '@/lib/dashboard/panel-queries'
import { cn } from '@/lib/utils'
import { Skeleton } from '@/components/dashboard/skeleton'

// The centered welcome band at the top of the Panel, painted in the
// line's own color (--primary), with the summary strip every role sees.

function greetingKey(hour: number) {
  if (hour < 12) return 'morning'
  if (hour < 19) return 'afternoon'
  return 'evening'
}

export function PanelHero({
  name,
  role,
  lineName,
  summary,
  scope,
}: {
  name: string | null
  role: AccountRole | null
  lineName: string | null
  summary: PanelSummary | null
  scope: 'own' | 'line'
}) {
  const t = useTranslations('Dashboard.panel.hero')
  const now = new Date()
  const firstName = name?.trim().split(/\s+/)[0]
  const date = now.toLocaleDateString('es-PE', { weekday: 'long', day: 'numeric', month: 'long' })

  return (
    <section
      className="relative isolate overflow-hidden rounded-3xl px-5 pt-9 pb-6 text-center text-white shadow-lg sm:px-8 sm:pt-11"
      style={{
        background:
          'radial-gradient(90% 120% at 50% -10%, color-mix(in oklab, var(--primary) 65%, white) 0%, transparent 60%),' +
          'linear-gradient(140deg, var(--primary) 0%, color-mix(in oklab, var(--primary) 58%, #0b1220) 100%)',
      }}
    >
      {/* Soft rings behind the greeting */}
      <span aria-hidden className="pointer-events-none absolute -top-40 -left-24 -z-10 h-80 w-80 rounded-full bg-white/8" />
      <span aria-hidden className="pointer-events-none absolute -right-16 -bottom-36 -z-10 h-72 w-72 rounded-full bg-white/7" />
      <span aria-hidden className="pointer-events-none absolute top-6 right-[18%] -z-10 h-24 w-24 rounded-full border border-white/15" />

      <div className="mx-auto flex max-w-2xl flex-col items-center gap-2">
        <span className="inline-flex items-center gap-2 rounded-full border border-white/25 bg-white/15 px-3 py-1 text-xs font-semibold backdrop-blur-sm">
          {role ? t(`roles.${role}`) : null}
          {lineName ? <span className="opacity-80">· {lineName}</span> : null}
        </span>
        <h1 className="text-[28px] leading-tight font-extrabold tracking-tight text-balance sm:text-4xl">
          {firstName ? t(`greeting.${greetingKey(now.getHours())}`, { name: firstName }) : t('greetingNoName')}
        </h1>
        <p className="text-sm capitalize opacity-85">{date}</p>
        <p className="text-sm opacity-90">{scope === 'own' ? t('scopeOwn') : t('scopeLine')}</p>
      </div>

      <div className="mx-auto mt-7 grid max-w-5xl grid-cols-2 gap-3 lg:grid-cols-5">
        {summary ? (
          <>
            <Kpi label={t('unanswered')} value={summary.unanswered} hint={t('conversations')} alert={summary.unanswered > 0 ? t('urgent') : null} />
            <Kpi label={t('waitingLong')} value={summary.waitingLong} hint={t('customers')} alert={summary.waitingLong > 0 ? t('attention') : null} />
            <Kpi label={t('windowsSoon')} value={summary.windowsSoon} hint={t('windowsHint')} alert={summary.windowsSoon > 0 ? t('lessThan3h') : null} />
            <Kpi label={t('closedToday')} value={summary.closedToday} hint={t('closedYesterday', { n: summary.closedYesterday })} />
            <AnsweredRing pct={summary.answeredTodayPct} label={t('answeredToday')} hint={t('answeredHint')} empty={t('noMessagesToday')} />
          </>
        ) : (
          Array.from({ length: 5 }, (_, i) => (
            <div key={i} className={cn('rounded-2xl border border-white/20 bg-white/12 p-4', i === 4 && 'col-span-2 lg:col-span-1')}>
              <Skeleton className="mx-auto h-3 w-20 bg-white/25" />
              <Skeleton className="mx-auto mt-3 h-8 w-12 bg-white/25" />
            </div>
          ))
        )}
      </div>
    </section>
  )
}

function Kpi({ label, value, hint, alert }: { label: string; value: number; hint: string; alert?: string | null }) {
  return (
    <Link
      href="/inbox"
      className="group flex flex-col items-center gap-1 rounded-2xl border border-white/20 bg-white/12 px-3 py-4 backdrop-blur-sm transition-colors hover:bg-white/20 focus-visible:ring-2 focus-visible:ring-white focus-visible:outline-none"
    >
      <span className="text-xs font-semibold opacity-90">{label}</span>
      <span className="text-4xl leading-none font-black tabular-nums">{value}</span>
      <span className="text-[11px] opacity-80">{hint}</span>
      {alert && <span className="mt-1 rounded-full bg-white px-2 py-0.5 text-[10px] font-extrabold text-red-500">{alert}</span>}
    </Link>
  )
}

function AnsweredRing({ pct, label, hint, empty }: { pct: number | null; label: string; hint: string; empty: string }) {
  const r = 30
  const c = 2 * Math.PI * r
  return (
    <div className="col-span-2 flex items-center justify-center gap-4 rounded-2xl border border-white/20 bg-white/12 px-3 py-3 backdrop-blur-sm lg:col-span-1">
      <svg viewBox="0 0 76 76" className="h-[76px] w-[76px] shrink-0" role="img" aria-label={pct === null ? empty : `${label}: ${pct}%`}>
        <circle cx="38" cy="38" r={r} fill="none" stroke="rgba(255,255,255,.22)" strokeWidth="8" />
        {pct !== null && pct > 0 && (
          <circle cx="38" cy="38" r={r} fill="none" stroke="#fff" strokeWidth="8" strokeLinecap="round" strokeDasharray={`${(c * pct) / 100} ${c}`} transform="rotate(-90 38 38)" />
        )}
        <text x="38" y="43" textAnchor="middle" fill="#fff" fontSize="16" fontWeight="900">
          {pct === null ? '—' : `${pct}%`}
        </text>
      </svg>
      <span className="text-left">
        <span className="block text-sm font-bold">{label}</span>
        <span className="block text-[11px] opacity-80">{pct === null ? empty : hint}</span>
      </span>
    </div>
  )
}
