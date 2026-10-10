'use client'

import Link from 'next/link'
import type { ComponentType, ReactNode } from 'react'
import { useTranslations } from 'next-intl'

import { cn } from '@/lib/utils'
import { avatarTintStyle } from '@/lib/inbox/avatar-tint'
import { Skeleton } from '@/components/dashboard/skeleton'

// Building blocks shared by the asesor and supervision panels. Every
// tint comes from --primary, so each line's deployment paints the panel
// in its own color with no per-line code.

export const brandMix = (pct: number, base = 'var(--card)') =>
  `color-mix(in oklab, var(--primary) ${pct}%, ${base})`

export type Tone = 'critical' | 'warning' | 'good' | 'brand' | 'muted'

const TONE_CLASS: Record<Tone, string> = {
  critical: 'bg-red-500/12 text-red-500',
  warning: 'bg-amber-500/15 text-amber-600',
  good: 'bg-emerald-500/12 text-emerald-600',
  brand: 'bg-primary/12 text-primary',
  muted: 'bg-muted text-muted-foreground',
}

export function Chip({ tone, children, className }: { tone: Tone; children: ReactNode; className?: string }) {
  return (
    <span className={cn('inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-bold whitespace-nowrap tabular-nums', TONE_CLASS[tone], className)}>
      {children}
    </span>
  )
}

export function PanelCard({
  icon: Icon,
  title,
  subtitle,
  badge,
  className,
  children,
}: {
  icon: ComponentType<{ className?: string }>
  title: string
  subtitle?: string
  badge?: ReactNode
  className?: string
  children: ReactNode
}) {
  return (
    <section className={cn('flex min-w-0 flex-col gap-4 rounded-2xl border border-border bg-card p-5 shadow-sm transition-shadow duration-200 hover:shadow-md', className)}>
      <header className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary/12 text-primary">
            <Icon className="h-5 w-5" />
          </span>
          <div className="min-w-0">
            <h2 className="text-[15px] leading-tight font-bold text-foreground">{title}</h2>
            {subtitle && <p className="mt-0.5 text-xs text-muted-foreground">{subtitle}</p>}
          </div>
        </div>
        {badge}
      </header>
      {children}
    </section>
  )
}

export function Initials({ seed, name, className }: { seed: string; name: string; className?: string }) {
  const initials = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase())
    .join('')
  return (
    <span
      className={cn('flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-xs font-bold', className)}
      style={avatarTintStyle(seed)}
      aria-hidden
    >
      {initials || '?'}
    </span>
  )
}

/** One person row linking to the conversation in the inbox. */
export function ConversationRow({
  conversationId,
  seed,
  name,
  detail,
  end,
}: {
  conversationId: string | null
  seed: string
  name: string
  detail?: string | null
  end?: ReactNode
}) {
  const body = (
    <>
      <Initials seed={seed} name={name} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-semibold text-foreground">{name}</span>
        {detail && <span className="block truncate text-xs text-muted-foreground">{detail}</span>}
      </span>
      {end && <span className="flex shrink-0 flex-col items-end gap-1.5">{end}</span>}
    </>
  )
  const cls = 'flex items-center gap-3 rounded-xl bg-muted/50 px-3 py-2.5 transition-colors'
  return conversationId ? (
    <Link href={`/inbox?c=${conversationId}`} className={cn(cls, 'hover:bg-primary/8 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none')}>
      {body}
    </Link>
  ) : (
    <div className={cls}>{body}</div>
  )
}

export function RowList({ children }: { children: ReactNode }) {
  return <div className="flex flex-col gap-2">{children}</div>
}

export function EmptyLine({ text }: { text: string }) {
  return (
    <div className="flex flex-1 items-center justify-center rounded-xl border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">
      {text}
    </div>
  )
}

export function MoreLink({ count }: { count: number }) {
  const t = useTranslations('Dashboard.panel')
  if (count <= 0) return null
  return (
    <Link href="/inbox" className="self-start text-xs font-semibold text-primary hover:underline">
      {t('seeMore', { count })}
    </Link>
  )
}

/** A horizontal bar row: label, track with one or more segments, value. */
export function BarRow({
  label,
  lead,
  segments,
  max,
  value,
  title,
}: {
  label: string
  lead?: ReactNode
  segments: { value: number; color: string }[]
  max: number
  value: ReactNode
  title?: string
}) {
  return (
    <div className="grid grid-cols-[minmax(84px,34%)_minmax(0,1fr)_auto] items-center gap-3 text-sm" title={title}>
      <span className="flex min-w-0 items-center gap-2 font-medium text-foreground/80">
        {lead}
        <span className="truncate">{label}</span>
      </span>
      <span className="flex h-3 gap-0.5 overflow-hidden rounded-full bg-muted">
        {segments.map((s, i) =>
          s.value > 0 ? (
            <span
              key={i}
              className="h-full first:rounded-l-full last:rounded-r-full"
              style={{ width: `${max > 0 ? (s.value / max) * 100 : 0}%`, background: s.color, minWidth: 4 }}
            />
          ) : null,
        )}
      </span>
      <span className="font-bold tabular-nums text-foreground">{value}</span>
    </div>
  )
}

export function Legend({ items }: { items: { label: string; color: string }[] }) {
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
      {items.map((i) => (
        <span key={i.label} className="inline-flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-[3px]" style={{ background: i.color }} />
          {i.label}
        </span>
      ))}
    </div>
  )
}

export function CardSkeleton({ className }: { className?: string }) {
  return (
    <div className={cn('flex flex-col gap-4 rounded-2xl border border-border bg-card p-5 shadow-sm', className)}>
      <div className="flex items-center gap-3">
        <Skeleton className="h-10 w-10 rounded-xl" />
        <Skeleton className="h-4 w-40" />
      </div>
      <Skeleton className="h-12 w-full rounded-xl" />
      <Skeleton className="h-12 w-full rounded-xl" />
      <Skeleton className="h-12 w-3/4 rounded-xl" />
    </div>
  )
}

/** "45 min", "2 h 10 min", "3 días" */
export function useDuration() {
  const t = useTranslations('Dashboard.panel.duration')
  return (ms: number) => {
    const min = Math.max(0, Math.round(ms / 60_000))
    if (min < 60) return t('minutes', { n: min })
    const h = Math.floor(min / 60)
    if (h < 24) return min % 60 ? t('hoursMinutes', { h, m: min % 60 }) : t('hours', { h })
    return t('days', { n: Math.floor(h / 24) })
  }
}

export function contactSeed(contactId: string | null | undefined, name: string) {
  return contactId ?? name
}
