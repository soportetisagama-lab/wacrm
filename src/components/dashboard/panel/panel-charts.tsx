'use client'

import { useId, useState } from 'react'
import { useTranslations } from 'next-intl'
import { brandMix } from './panel-ui'

// Small hand-drawn SVG charts for the Panel. All marks use --primary
// (the line's color); the comparison series is a dashed neutral line.

/** Sent (area, brand) vs received (dashed line) per hour, with a hover crosshair. */
export function HourlyChart({ hours }: { hours: { hour: number; sent: number; received: number }[] }) {
  const t = useTranslations('Dashboard.panel.hourly')
  const gradId = 'g' + useId().replace(/[^a-zA-Z0-9_-]/g, '')
  const [hover, setHover] = useState<number | null>(null)

  // Show the working day, widened to any hour that actually had traffic.
  const active = hours.filter((h) => h.sent + h.received > 0).map((h) => h.hour)
  const from = Math.min(8, ...active)
  const to = Math.max(20, ...active)
  const data = hours.slice(from, to + 1)

  const W = 600
  const H = 150
  const max = Math.max(4, ...data.map((d) => Math.max(d.sent, d.received)))
  const step = W / Math.max(1, data.length - 1)
  const y = (v: number) => H - (v / max) * (H - 8)
  const line = (key: 'sent' | 'received') => data.map((d, i) => `${i * step},${y(d[key])}`).join(' ')
  const h = hover === null ? null : data[hover]

  return (
    <div className="relative">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        className="block h-40 w-full overflow-visible"
        role="img"
        aria-label={t('aria')}
        onMouseLeave={() => setHover(null)}
      >
        <defs>
          <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="var(--primary)" stopOpacity="0.35" />
            <stop offset="1" stopColor="var(--primary)" stopOpacity="0" />
          </linearGradient>
        </defs>
        {[0.25, 0.5, 0.75].map((f) => (
          <line key={f} x1="0" x2={W} y1={H * f} y2={H * f} stroke="var(--border)" strokeWidth="1" vectorEffect="non-scaling-stroke" />
        ))}
        <polygon points={`0,${H} ${line('sent')} ${W},${H}`} fill={`url(#${gradId})`} />
        <polyline points={line('received')} fill="none" stroke="var(--muted-foreground)" strokeWidth="2" strokeDasharray="5 5" vectorEffect="non-scaling-stroke" />
        <polyline points={line('sent')} fill="none" stroke="var(--primary)" strokeWidth="2.5" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
        {hover !== null && (
          <line x1={hover * step} x2={hover * step} y1="0" y2={H} stroke="var(--foreground)" strokeOpacity="0.25" strokeWidth="1" vectorEffect="non-scaling-stroke" />
        )}
        {data.map((_, i) => (
          <rect key={i} x={i * step - step / 2} y="0" width={step} height={H} fill="transparent" onMouseEnter={() => setHover(i)} />
        ))}
      </svg>
      {h && hover !== null && (
        <div
          className="pointer-events-none absolute top-0 z-10 -translate-x-1/2 rounded-lg bg-foreground px-2.5 py-1.5 text-xs font-semibold whitespace-nowrap text-background shadow-lg"
          style={{ left: `${(hover / Math.max(1, data.length - 1)) * 100}%` }}
        >
          {`${h.hour}:00`} · {t('sentN', { n: h.sent })} · {t('receivedN', { n: h.received })}
        </div>
      )}
      <div className="mt-1.5 flex justify-between text-[11px] text-muted-foreground tabular-nums">
        {data.filter((_, i) => i % 2 === 0).map((d) => (
          <span key={d.hour}>{`${d.hour}:00`}</span>
        ))}
      </div>
    </div>
  )
}

/** Median first-reply minutes over the last 7 days. Days without samples leave a gap in the dots, not the line. */
export function ResponseSparkline({ days }: { days: { day: number; minutes: number | null }[] }) {
  const gradId = 'g' + useId().replace(/[^a-zA-Z0-9_-]/g, '')
  const W = 300
  const H = 70
  const vals = days.map((d) => d.minutes).filter((v): v is number => v !== null)
  if (vals.length === 0) return null
  const max = Math.max(...vals) * 1.15 || 1
  const step = W / Math.max(1, days.length - 1)
  const pts = days
    .map((d, i) => (d.minutes === null ? null : ([i * step, H - (d.minutes / max) * (H - 6)] as const)))
    .filter((p): p is readonly [number, number] => p !== null)
  const poly = pts.map((p) => p.join(',')).join(' ')
  // Up to ~8 labels: weekday initials for a week, day numbers for longer ranges.
  const labelEvery = Math.max(1, Math.ceil(days.length / 8))
  const fmtDay = (ms: number) =>
    days.length <= 7
      ? new Date(ms).toLocaleDateString('es-PE', { weekday: 'narrow' }).toUpperCase()
      : new Date(ms).toLocaleDateString('es-PE', { day: 'numeric', month: 'short' })
  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="block h-[70px] w-full overflow-visible" aria-hidden>
        <defs>
          <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="var(--primary)" stopOpacity="0.3" />
            <stop offset="1" stopColor="var(--primary)" stopOpacity="0" />
          </linearGradient>
        </defs>
        {pts.length > 1 && <polygon points={`${pts[0][0]},${H} ${poly} ${pts[pts.length - 1][0]},${H}`} fill={`url(#${gradId})`} />}
        <polyline points={poly} fill="none" stroke="var(--primary)" strokeWidth="2.5" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
      </svg>
      <div className="mt-1 flex justify-between text-[11px] text-muted-foreground tabular-nums">
        {days
          .filter((_, i) => i % labelEvery === 0 || i === days.length - 1)
          .map((d) => (
            <span key={d.day} title={d.minutes === null ? undefined : `${Math.round(d.minutes)} min`}>
              {fmtDay(d.day)}
            </span>
          ))}
      </div>
    </div>
  )
}

const HEAT_STEPS = [0, 18, 34, 52, 72, 100]

/** Customer messages by weekday × hour, shaded from the line color. */
export function Heatmap({ grid }: { grid: number[][] }) {
  const t = useTranslations('Dashboard.panel.heatmap')
  const days = t('days').split(',')
  let from = 8
  let to = 20
  grid.forEach((row) => row.forEach((v, h) => {
    if (v > 0) {
      from = Math.min(from, h)
      to = Math.max(to, h)
    }
  }))
  const hours = Array.from({ length: to - from + 1 }, (_, i) => from + i)
  const max = Math.max(1, ...grid.flat())
  const shade = (v: number) => {
    if (v === 0) return 'var(--muted)'
    const step = Math.min(HEAT_STEPS.length - 1, Math.max(1, Math.ceil((v / max) * (HEAT_STEPS.length - 1))))
    return brandMix(HEAT_STEPS[step])
  }
  return (
    <div className="overflow-x-auto">
      <div className="grid min-w-[420px] gap-[3px] text-[10px] text-muted-foreground" style={{ gridTemplateColumns: `2.25rem repeat(${hours.length}, minmax(0, 1fr))` }}>
        <span />
        {hours.map((h) => (
          <span key={h} className="text-center tabular-nums">{h}</span>
        ))}
        {grid.map((row, d) => (
          <div key={d} className="contents">
            <span className="self-center">{days[d]}</span>
            {hours.map((h) => (
              <span
                key={h}
                className="aspect-[1.4] rounded-[4px]"
                style={{ background: shade(row[h]) }}
                title={t('cell', { day: days[d], hour: h, n: row[h] })}
              />
            ))}
          </div>
        ))}
      </div>
      <div className="mt-3 flex items-center gap-1.5 text-[11px] text-muted-foreground">
        {t('less')}
        {[1, 2, 3, 4, 5].map((s) => (
          <span key={s} className="h-2.5 w-4 rounded-[3px]" style={{ background: brandMix(HEAT_STEPS[s]) }} />
        ))}
        {t('more')}
      </div>
    </div>
  )
}
