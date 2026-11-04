"use client"

import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import {
  Zap,
  Plus,
  MoreVertical,
  Copy,
  Pencil,
  Trash2,
  FileText,
  MessageCircle,
  Clock,
  Users,
  PhoneCall,
  Loader2,
  Activity,
  History,
  ChevronRight,
} from "lucide-react"

import { createClient } from "@/lib/supabase/client"
import { useCan } from "@/hooks/use-can"
import { useLocale, useTranslations } from "next-intl"
import type { Automation } from "@/types"
import { Button } from "@/components/ui/button"
import { GatedButton } from "@/components/ui/gated-button"
import { Switch } from "@/components/ui/switch"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import type { TemplateSlug } from "@/lib/automations/templates"
import {
  TRIGGER_PILL_CLASS,
  formatRelative,
  isKnownTrigger,
} from "@/lib/automations/trigger-meta"
import { cn } from "@/lib/utils"

const TEMPLATE_ORDER: TemplateSlug[] = [
  "welcome_message",
  "out_of_office",
  "lead_qualifier",
  "follow_up_reminder",
]

const TEMPLATE_ICON: Record<TemplateSlug, typeof Zap> = {
  welcome_message: MessageCircle,
  out_of_office: Clock,
  lead_qualifier: Users,
  follow_up_reminder: PhoneCall,
}

/** Legacy default name saved by older builds; shown localized. */
const LEGACY_UNTITLED = "Untitled automation"

export default function AutomationsPage() {
  const router = useRouter()
  const canCreate = useCan("send-messages")
  const t = useTranslations("Automations.list")
  const [automations, setAutomations] = useState<Automation[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pendingDelete, setPendingDelete] = useState<Automation | null>(null)
  const [deleting, setDeleting] = useState(false)

  async function load() {
    try {
      const supabase = createClient()
      const { data, error: fetchErr } = await supabase
        .from("automations")
        .select("*")
        .order("created_at", { ascending: false })
      if (fetchErr) throw fetchErr
      setAutomations((data ?? []) as Automation[])
    } catch {
      setError(t("loadError"))
    }
  }

  useEffect(() => {
    // Deferred to a microtask so the state updates land outside the
    // effect body (react-hooks/set-state-in-effect).
    void Promise.resolve().then(load)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- load once on mount
  }, [])

  async function toggleActive(a: Automation, next: boolean) {
    // Optimistic flip so the switch feels instant.
    setAutomations((prev) =>
      prev?.map((x) => (x.id === a.id ? { ...x, is_active: next } : x)) ?? prev,
    )
    const res = await fetch(`/api/automations/${a.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ is_active: next }),
    })
    if (!res.ok) {
      // Roll back on error.
      setAutomations((prev) =>
        prev?.map((x) => (x.id === a.id ? { ...x, is_active: !next } : x)) ?? prev,
      )
      toast.error(t("toasts.updateError"))
      return
    }
    toast.success(next ? t("toasts.activated") : t("toasts.paused"))
  }

  async function duplicate(a: Automation) {
    const res = await fetch(`/api/automations/${a.id}/duplicate`, { method: "POST" })
    if (!res.ok) {
      toast.error(t("toasts.duplicateError"))
      return
    }
    toast.success(t("toasts.duplicated"))
    load()
  }

  async function confirmDelete() {
    if (!pendingDelete) return
    setDeleting(true)
    const res = await fetch(`/api/automations/${pendingDelete.id}`, { method: "DELETE" })
    setDeleting(false)
    if (!res.ok) {
      toast.error(t("toasts.deleteError"))
      return
    }
    toast.success(t("toasts.deleted"))
    setPendingDelete(null)
    load()
  }

  function startFromTemplate(slug: TemplateSlug) {
    router.push(`/automations/new?template=${slug}`)
  }

  const createButton = (
    <GatedButton
      canAct={canCreate}
      title={canCreate ? undefined : t("readOnly")}
      onClick={() => router.push("/automations/new")}
      className="rounded-xl bg-primary text-primary-foreground shadow-sm hover:bg-primary/90"
    >
      <Plus className="h-4 w-4" />
      {t("create")}
    </GatedButton>
  )

  const activeCount = automations?.filter((a) => a.is_active).length ?? 0

  return (
    <div className="flex w-full min-w-0 flex-col gap-6">
      {/* Header — boxed like the broadcast detail: icon + title left, action right. */}
      <section className="relative isolate flex flex-wrap items-center justify-between gap-3 overflow-hidden rounded-3xl border border-border bg-card px-5 py-5 shadow-sm sm:px-8">
        <span
          aria-hidden
          className="pointer-events-none absolute inset-x-0 top-0 -z-10 h-32"
          style={{ background: "radial-gradient(60% 100% at 50% 0%, color-mix(in oklab, var(--primary) 14%, transparent), transparent 75%)" }}
        />
        <div className="flex min-w-0 items-center gap-4">
        <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary" aria-hidden>
          <Zap className="h-5 w-5" />
        </span>
        <div className="min-w-0">
          <h1 className="text-2xl leading-tight font-extrabold tracking-tight text-foreground">{t("title")}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{t("subtitle")}</p>
          {automations && automations.length > 0 && (
            <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
              <span className="rounded-full border border-border bg-card px-2.5 py-1 font-medium tabular-nums text-foreground shadow-sm">
                {t("count", { count: automations.length })}
              </span>
              <span className="rounded-full border border-primary/25 bg-primary/10 px-2.5 py-1 font-medium tabular-nums text-primary shadow-sm">
                {t("activeCount", { count: activeCount })}
              </span>
            </div>
          )}
        </div>
        </div>
        {createButton}
      </section>

      {error ? (
        <div className="rounded-2xl border border-border bg-card p-8 text-center shadow-sm">
          <p className="text-sm font-semibold text-foreground">{error}</p>
          <Button
            variant="outline"
            className="mt-3 rounded-xl"
            onClick={() => window.location.reload()}
          >
            {t("retry")}
          </Button>
        </div>
      ) : automations === null ? (
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2" aria-busy>
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="h-28 animate-pulse rounded-xl bg-muted" />
          ))}
        </div>
      ) : (
        <>
          {automations.length < 3 && (
            <TemplatesSection onPick={startFromTemplate} />
          )}

          {automations.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-border bg-card/40 px-4 py-10 text-center">
              <div className="flex h-12 w-12 items-center justify-center rounded-full bg-primary/10 text-primary">
                <Zap className="h-6 w-6" />
              </div>
              <p className="mt-1 text-sm font-semibold text-foreground">{t("emptyTitle")}</p>
              <p className="max-w-sm text-xs text-muted-foreground">{t("emptyDesc")}</p>
              <div className="mt-2">{createButton}</div>
            </div>
          ) : (
            <section className="flex flex-col gap-3">
              <h2 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
                {t("myAutomations")}
              </h2>
              <ul className="grid grid-cols-1 gap-3 lg:grid-cols-2">
                {automations.map((a) => (
                  <AutomationCard
                    key={a.id}
                    automation={a}
                    onToggle={(next) => toggleActive(a, next)}
                    onEdit={() => router.push(`/automations/${a.id}/edit`)}
                    onDuplicate={() => duplicate(a)}
                    onLogs={() => router.push(`/automations/${a.id}/logs`)}
                    onDelete={() => setPendingDelete(a)}
                  />
                ))}
              </ul>
            </section>
          )}
        </>
      )}

      <Dialog open={!!pendingDelete} onOpenChange={(v) => !v && setPendingDelete(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("deleteTitle")}</DialogTitle>
            <DialogDescription>
              {t("deleteDesc", { name: pendingDelete ? displayName(pendingDelete.name, t("untitled")) : "" })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => setPendingDelete(null)}
              disabled={deleting}
            >
              {t("cancel")}
            </Button>
            <Button
              variant="destructive"
              onClick={confirmDelete}
              disabled={deleting}
            >
              {deleting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
              {t("delete")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

function displayName(name: string | null | undefined, fallback: string): string {
  const trimmed = (name ?? "").trim()
  if (!trimmed || trimmed === LEGACY_UNTITLED) return fallback
  return trimmed
}

function TemplatesSection({ onPick }: { onPick: (slug: TemplateSlug) => void }) {
  const t = useTranslations("Automations.list")
  const tt = useTranslations("Automations.templates")
  return (
    <section className="flex flex-col gap-3">
      <div>
        <h2 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
          {t("templatesTitle")}
        </h2>
        <p className="mt-0.5 text-xs text-muted-foreground">{t("templatesHint")}</p>
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {TEMPLATE_ORDER.map((slug) => {
          const Icon = TEMPLATE_ICON[slug]
          return (
            <button
              key={slug}
              type="button"
              onClick={() => onPick(slug)}
              className="group flex min-w-0 items-start gap-3 rounded-xl border border-border bg-card p-4 text-left shadow-sm transition-all duration-200 hover:-translate-y-0.5 hover:border-primary/40 hover:shadow-md focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
            >
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary transition-transform duration-200 group-hover:scale-105">
                <Icon className="h-4 w-4" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="text-sm font-semibold text-foreground">{tt(`${slug}.name`)}</div>
                <p className="mt-0.5 text-xs text-muted-foreground">{tt(`${slug}.description`)}</p>
              </div>
            </button>
          )
        })}
      </div>
    </section>
  )
}

function AutomationCard({
  automation,
  onToggle,
  onEdit,
  onDuplicate,
  onLogs,
  onDelete,
}: {
  automation: Automation
  onToggle: (next: boolean) => void
  onEdit: () => void
  onDuplicate: () => void
  onLogs: () => void
  onDelete: () => void
}) {
  const t = useTranslations("Automations.list")
  const tb = useTranslations("Automations.builder")
  const locale = useLocale()
  const triggerLabel = isKnownTrigger(automation.trigger_type)
    ? tb(`triggers.${automation.trigger_type}.label`)
    : automation.trigger_type
  const lastRun = formatRelative(automation.last_executed_at, locale) ?? t("never")
  const active = automation.is_active
  const runs = automation.execution_count ?? 0

  return (
    <li
      className={cn(
        "group flex min-w-0 flex-col rounded-xl border border-border bg-card shadow-sm transition-shadow duration-200 hover:shadow-md",
        active ? "border-l-[3px] border-l-primary" : "border-l-[3px] border-l-border",
      )}
    >
      <div className="flex min-w-0 items-start gap-3 p-4">
        <div
          className={cn(
            "flex h-9 w-9 shrink-0 items-center justify-center rounded-lg",
            active ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground",
          )}
          aria-hidden
        >
          <Zap className="h-4 w-4" />
        </div>

        <button
          type="button"
          onClick={onEdit}
          className="min-w-0 flex-1 text-left focus-visible:outline-none"
        >
          <div className="flex min-w-0 items-center gap-2">
            <span className="truncate text-sm font-semibold text-foreground group-hover:text-primary">
              {displayName(automation.name, t("untitled"))}
            </span>
            <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" aria-hidden />
          </div>
          {automation.description && (
            <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{automation.description}</p>
          )}
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            <span
              className={cn(
                "inline-flex max-w-full items-center gap-1 truncate rounded-full border px-2.5 py-0.5 text-[11px] font-medium",
                TRIGGER_PILL_CLASS,
              )}
              title={triggerLabel}
            >
              <Zap className="h-3 w-3 shrink-0" aria-hidden />
              <span className="truncate">{triggerLabel}</span>
            </span>
          </div>
        </button>

        <div className="flex shrink-0 items-center gap-1">
          <DropdownMenu>
            <DropdownMenuTrigger
              aria-label={t("openMenu")}
              className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground data-[popup-open]:bg-muted"
            >
              <MoreVertical className="h-4 w-4" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={onEdit}>
                <Pencil className="h-4 w-4" />
                {t("edit")}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={onDuplicate}>
                <Copy className="h-4 w-4" />
                {t("duplicate")}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={onLogs}>
                <FileText className="h-4 w-4" />
                {t("viewLogs")}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" onClick={onDelete}>
                <Trash2 className="h-4 w-4" />
                {t("delete")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {/* Footer: stats left, status + switch right. Wraps on narrow phones. */}
      <div className="mt-auto flex flex-wrap items-center justify-between gap-x-3 gap-y-2 border-t border-border px-4 py-2.5 text-xs text-muted-foreground">
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
          <span className="inline-flex items-center gap-1 tabular-nums">
            <Activity className="h-3.5 w-3.5" aria-hidden />
            {runs === 1 ? t("runs", { count: runs }) : t("runsPlural", { count: runs })}
          </span>
          <span className="inline-flex items-center gap-1">
            <History className="h-3.5 w-3.5" aria-hidden />
            {t("lastRun", { time: lastRun })}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <span
            className={cn(
              "inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium",
              active
                ? "border-primary/25 bg-primary/10 text-primary"
                : "border-border bg-muted text-muted-foreground",
            )}
          >
            <span
              className={cn("h-1.5 w-1.5 rounded-full", active ? "bg-primary" : "bg-muted-foreground/60")}
              aria-hidden
            />
            {active ? t("statusActive") : t("statusInactive")}
          </span>
          <Switch
            checked={active}
            onCheckedChange={(v) => onToggle(!!v)}
            aria-label={active ? t("deactivate") : t("activate")}
          />
        </div>
      </div>
    </li>
  )
}
