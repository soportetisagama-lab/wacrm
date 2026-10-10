"use client"

import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslations } from 'next-intl'
import { RefreshCw } from 'lucide-react'

import { createClient } from '@/lib/supabase/client'
import { useAuth } from '@/hooks/use-auth'
import {
  loadAdvisorPanel,
  loadSupervisorPanel,
  type AdvisorPanelData,
  type SupervisorPanelData,
} from '@/lib/dashboard/panel-queries'
import { PanelHero } from '@/components/dashboard/panel/panel-hero'
import { AdvisorPanel } from '@/components/dashboard/panel/advisor-panel'
import { SupervisorPanel } from '@/components/dashboard/panel/supervisor-panel'
import { CardSkeleton } from '@/components/dashboard/panel/panel-ui'
import {
  DateRangeFilter,
  presetRange,
  rangeLabel,
  toPanelRange,
  type DayRange,
} from '@/components/dashboard/panel/date-range-filter'

// Role-based Panel, built only from inbox data. An Asesor (agent) gets
// "Mi día" for their own chats; every other role gets "Supervisión" for
// the whole line. RLS already limits what an Asesor can read, so the
// view choice here is about which widgets help, not about access.

const REFRESH_MS = 60_000

type PanelState =
  | { kind: 'advisor'; data: AdvisorPanelData }
  | { kind: 'supervisor'; data: SupervisorPanelData }

export default function DashboardPage() {
  const t = useTranslations('Dashboard.panel')
  const { user, profile, account, accountRole, profileLoading } = useAuth()
  const isAdvisor = accountRole === 'agent'
  const [panel, setPanel] = useState<PanelState | null>(null)
  const [error, setError] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  // Always opens on the current month so far (1st → today).
  const [days, setDays] = useState<DayRange>(() => presetRange('month'))

  // Only the newest request may write state, so a slow load for an old
  // range can't overwrite the one the user just picked.
  const requestId = useRef(0)

  const load = useCallback(async () => {
    if (!user || !accountRole) return
    const id = ++requestId.current
    setRefreshing(true)
    try {
      const db = createClient()
      const range = toPanelRange(days)
      const next: PanelState =
        accountRole === 'agent'
          ? { kind: 'advisor', data: await loadAdvisorPanel(db, user.id, range) }
          : { kind: 'supervisor', data: await loadSupervisorPanel(db, range) }
      if (id !== requestId.current) return
      setPanel(next)
      setError(false)
    } catch (err) {
      if (id !== requestId.current) return
      console.error('[dashboard] panel failed:', err)
      setError(true)
    } finally {
      if (id === requestId.current) setRefreshing(false)
    }
  }, [user, accountRole, days])

  useEffect(() => {
    if (profileLoading) return
    const first = setTimeout(() => void load(), 0)
    // Keep the numbers fresh while the tab is open; skip hidden tabs.
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') void load()
    }, REFRESH_MS)
    return () => {
      clearTimeout(first)
      clearInterval(timer)
    }
  }, [load, profileLoading])

  if (profileLoading) {
    return <div className="h-72 animate-pulse rounded-3xl bg-muted" />
  }

  const summary = panel?.data.summary ?? null

  return (
    <div className="flex w-full flex-col gap-6">
      <PanelHero
        name={profile?.full_name ?? null}
        role={accountRole}
        lineName={account?.name ?? null}
        summary={summary}
        scope={isAdvisor ? 'own' : 'line'}
        rangeLabel={rangeLabel(days)}
      />

      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-xl font-extrabold text-foreground">{isAdvisor ? t('advisorTitle') : t('supervisorTitle')}</h2>
          <p className="mt-0.5 text-sm text-muted-foreground">{isAdvisor ? t('advisorSubtitle') : t('supervisorSubtitle')}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
        <DateRangeFilter value={days} onChange={setDays} />
        <button
          type="button"
          onClick={() => void load()}
          disabled={refreshing}
          className="inline-flex items-center gap-2 rounded-xl border border-border bg-card px-3 py-2 text-sm font-semibold text-foreground shadow-sm transition-colors hover:bg-muted disabled:opacity-60"
        >
          <RefreshCw className={refreshing ? 'h-4 w-4 animate-spin' : 'h-4 w-4'} />
          {t('refresh')}
        </button>
        </div>
      </div>

      {error && !panel ? (
        <div className="rounded-2xl border border-border bg-card p-8 text-center">
          <p className="font-semibold text-foreground">{t('errorTitle')}</p>
          <p className="mt-1 text-sm text-muted-foreground">{t('errorBody')}</p>
        </div>
      ) : !panel ? (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {Array.from({ length: 6 }, (_, i) => (
            <CardSkeleton key={i} />
          ))}
        </div>
      ) : panel.kind === 'advisor' ? (
        <AdvisorPanel data={panel.data} />
      ) : (
        <SupervisorPanel data={panel.data} />
      )}
    </div>
  )
}
