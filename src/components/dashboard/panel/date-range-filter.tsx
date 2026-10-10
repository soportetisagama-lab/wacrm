'use client'

import { useTranslations } from 'next-intl'
import { CalendarDays } from 'lucide-react'
import { cn } from '@/lib/utils'

// Date range for the Panel. Values are local calendar days as
// "YYYY-MM-DD" (the native date input's format); the page turns them
// into a [from, to) millisecond range. Default: first of the month → today.

export interface DayRange {
  from: string
  to: string
}

const pad = (n: number) => String(n).padStart(2, '0')
export const dayKey = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`

export function parseDay(key: string): Date {
  const [y, m, d] = key.split('-').map(Number)
  return new Date(y, m - 1, d)
}

type Preset = 'month' | 'today' | 'week' | 'lastMonth'

export function presetRange(preset: Preset, today = new Date()): DayRange {
  const y = today.getFullYear()
  const m = today.getMonth()
  switch (preset) {
    case 'today':
      return { from: dayKey(today), to: dayKey(today) }
    case 'week':
      return { from: dayKey(new Date(y, m, today.getDate() - 6)), to: dayKey(today) }
    case 'lastMonth':
      return { from: dayKey(new Date(y, m - 1, 1)), to: dayKey(new Date(y, m, 0)) }
    case 'month':
    default:
      return { from: dayKey(new Date(y, m, 1)), to: dayKey(today) }
  }
}

/** [from 00:00, day after `to` 00:00) in local time. */
export function toPanelRange(r: DayRange): { from: number; to: number } {
  const to = parseDay(r.to)
  to.setDate(to.getDate() + 1)
  return { from: parseDay(r.from).getTime(), to: to.getTime() }
}

export function rangeLabel(r: DayRange): string {
  const fmt = (k: string) => parseDay(k).toLocaleDateString('es-PE', { day: 'numeric', month: 'short' })
  return r.from === r.to ? fmt(r.from) : `${fmt(r.from)} – ${fmt(r.to)}`
}

export function DateRangeFilter({ value, onChange }: { value: DayRange; onChange: (r: DayRange) => void }) {
  const t = useTranslations('Dashboard.panel.filter')
  const today = dayKey(new Date())
  const presets: Preset[] = ['month', 'week', 'today', 'lastMonth']
  const active = presets.find((p) => {
    const r = presetRange(p)
    return r.from === value.from && r.to === value.to
  })

  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="flex flex-wrap gap-1 rounded-xl border border-border bg-card p-1 shadow-sm" role="group" aria-label={t('presets')}>
        {presets.map((p) => (
          <button
            key={p}
            type="button"
            onClick={() => onChange(presetRange(p))}
            aria-pressed={active === p}
            className={cn(
              'rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors',
              active === p ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted hover:text-foreground',
            )}
          >
            {t(`preset.${p}`)}
          </button>
        ))}
      </div>
      <div className="flex items-center gap-2 rounded-xl border border-border bg-card px-3 py-1.5 text-sm shadow-sm">
        <CalendarDays className="h-4 w-4 text-primary" aria-hidden />
        <label className="sr-only" htmlFor="panel-from">{t('from')}</label>
        <input
          id="panel-from"
          type="date"
          value={value.from}
          max={value.to}
          onChange={(e) => e.target.value && onChange({ from: e.target.value, to: value.to })}
          className="bg-transparent text-sm font-medium text-foreground tabular-nums outline-none"
        />
        <span className="text-muted-foreground">–</span>
        <label className="sr-only" htmlFor="panel-to">{t('to')}</label>
        <input
          id="panel-to"
          type="date"
          value={value.to}
          min={value.from}
          max={today}
          onChange={(e) => e.target.value && onChange({ from: value.from, to: e.target.value })}
          className="bg-transparent text-sm font-medium text-foreground tabular-nums outline-none"
        />
      </div>
    </div>
  )
}
