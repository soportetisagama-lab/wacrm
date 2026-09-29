"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { format } from "date-fns";
import { useTranslations } from "next-intl";
import {
  Loader2,
  MessageSquare,
  PhoneIncoming,
  PhoneMissed,
  PhoneOutgoing,
  Search,
} from "lucide-react";

import { createClient } from "@/lib/supabase/client";
import { CallContactButton } from "@/components/calls/call-contact-button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

/** "Llamadas" — history of WhatsApp calls (migrations 071/073). RLS
 *  scopes it: an Asesor only sees calls from their own conversations. */

interface CallListRow {
  id: string;
  direction: string;
  status: string;
  duration_seconds: number | null;
  created_at: string;
  conversation_id: string | null;
  contact_id: string | null;
  answered_by: string | null;
  contact: { name: string | null; phone: string | null } | null;
}

type Filter = "all" | "inbound" | "outbound" | "missed";

const MISSED = new Set(["missed", "rejected", "failed"]);

function duration(s: number | null) {
  const v = s ?? 0;
  return `${Math.floor(v / 60)}:${String(v % 60).padStart(2, "0")}`;
}

export default function CallsPage() {
  const t = useTranslations("Calls");
  const router = useRouter();
  const [rows, setRows] = useState<CallListRow[] | null>(null);
  const [agents, setAgents] = useState<Map<string, string>>(new Map());
  const [filter, setFilter] = useState<Filter>("all");
  const [search, setSearch] = useState("");

  const load = useCallback(async () => {
    const supabase = createClient();
    const { data } = await supabase
      .from("whatsapp_calls")
      .select(
        "id, direction, status, duration_seconds, created_at, conversation_id, contact_id, answered_by, contact:contacts(name, phone)",
      )
      .order("created_at", { ascending: false })
      .limit(300);
    setRows(
      ((data ?? []) as unknown as (CallListRow & { contact: CallListRow["contact"] | CallListRow["contact"][] })[]).map(
        (r) => ({ ...r, contact: Array.isArray(r.contact) ? (r.contact[0] ?? null) : r.contact }),
      ),
    );
  }, []);

  useEffect(() => {
    const supabase = createClient();
    void (async () => {
      await load();
      const { data } = await supabase.from("profiles").select("user_id, full_name");
      setAgents(new Map((data ?? []).map((p: { user_id: string; full_name: string | null }) => [p.user_id, p.full_name ?? ""])));
    })();
    const channel = supabase
      .channel("calls-page")
      .on("postgres_changes", { event: "*", schema: "public", table: "whatsapp_calls" }, () => void load())
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [load]);

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (rows ?? []).filter((r) => {
      if (filter === "inbound" && r.direction !== "inbound") return false;
      if (filter === "outbound" && r.direction !== "outbound") return false;
      if (filter === "missed" && !MISSED.has(r.status)) return false;
      if (!q) return true;
      return `${r.contact?.name ?? ""} ${r.contact?.phone ?? ""}`.toLowerCase().includes(q);
    });
  }, [rows, filter, search]);

  const statusLabel = (r: CallListRow) =>
    r.status === "ringing"
      ? t("logRinging")
      : r.status === "accepted"
        ? t("logLive")
        : r.status === "rejected"
          ? t("logRejected")
          : MISSED.has(r.status)
            ? t("logMissed")
            : duration(r.duration_seconds);

  return (
    <div className="mx-auto max-w-4xl space-y-4">
      <div>
        <h1 className="text-2xl font-bold text-foreground">{t("pageTitle")}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{t("pageDesc")}</p>
      </div>

      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t("searchPlaceholder")}
            className="pl-9"
          />
        </div>
        <div className="flex gap-1 rounded-lg bg-muted p-1">
          {(["all", "inbound", "outbound", "missed"] as Filter[]).map((f) => (
            <button
              key={f}
              type="button"
              onClick={() => setFilter(f)}
              className={cn(
                "rounded-md px-3 py-1.5 text-xs font-medium transition-colors",
                filter === f ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
              )}
            >
              {t(`filter_${f}`)}
            </button>
          ))}
        </div>
      </div>

      {rows === null ? (
        <div className="flex h-48 items-center justify-center">
          <Loader2 className="h-6 w-6 animate-spin text-primary" />
        </div>
      ) : visible.length === 0 ? (
        <p className="py-12 text-center text-sm text-muted-foreground">{t("empty")}</p>
      ) : (
        <div className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-card">
          {visible.map((r) => {
            const missed = MISSED.has(r.status);
            const Icon = missed ? PhoneMissed : r.direction === "outbound" ? PhoneOutgoing : PhoneIncoming;
            const name = r.contact?.name || r.contact?.phone || t("unknownCaller");
            const agent = r.answered_by ? agents.get(r.answered_by) : null;
            return (
              <div key={r.id} className="flex items-center gap-3 px-4 py-3">
                <div
                  className={cn(
                    "flex h-9 w-9 shrink-0 items-center justify-center rounded-full",
                    missed ? "bg-red-500/10 text-red-500" : "bg-green-600/10 text-green-600",
                  )}
                >
                  <Icon className="h-4 w-4" />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-foreground">{name}</p>
                  <p className="truncate text-xs text-muted-foreground">
                    {r.direction === "outbound" ? t("outgoingLabel") : t("incomingLabel")}
                    {" · "}
                    <span className={cn(missed && "text-red-500")}>{statusLabel(r)}</span>
                    {agent ? ` · ${agent}` : ""}
                  </p>
                </div>
                <span className="hidden shrink-0 text-xs text-muted-foreground sm:block">
                  {format(new Date(r.created_at), "dd/MM/yyyy HH:mm")}
                </span>
                {r.conversation_id && (
                  <button
                    type="button"
                    onClick={() => router.push(`/inbox?c=${r.conversation_id}`)}
                    title={t("openChat")}
                    aria-label={t("openChat")}
                    className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
                  >
                    <MessageSquare className="h-4 w-4" />
                  </button>
                )}
                {r.contact_id && (
                  <CallContactButton contactId={r.contact_id} name={name} className="h-8 w-8 shrink-0" />
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
