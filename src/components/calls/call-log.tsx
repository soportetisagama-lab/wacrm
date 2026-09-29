"use client";

import { useEffect, useState } from "react";
import { format } from "date-fns";
import { useTranslations } from "next-intl";
import { PhoneIncoming, PhoneMissed } from "lucide-react";

import { createClient } from "@/lib/supabase/client";
import { cn } from "@/lib/utils";

/** A WhatsApp call as shown in the thread (migration 071). */
export interface ThreadCall {
  id: string;
  status: string;
  duration_seconds: number | null;
  created_at: string;
}

/** This conversation's calls, kept live over realtime. */
export function useConversationCalls(
  conversationId: string | null | undefined,
  resyncToken?: unknown,
): ThreadCall[] {
  const [calls, setCalls] = useState<ThreadCall[]>([]);

  useEffect(() => {
    if (!conversationId) return;
    const supabase = createClient();
    let cancelled = false;
    const load = async () => {
      const { data } = await supabase
        .from("whatsapp_calls")
        .select("id, status, duration_seconds, created_at")
        .eq("conversation_id", conversationId)
        .order("created_at", { ascending: true });
      if (!cancelled) setCalls((data as ThreadCall[]) ?? []);
    };
    void load();
    const channel = supabase
      .channel(`calls:${conversationId}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "whatsapp_calls",
          filter: `conversation_id=eq.${conversationId}`,
        },
        () => void load(),
      )
      .subscribe();
    return () => {
      cancelled = true;
      supabase.removeChannel(channel);
    };
  }, [conversationId, resyncToken]);

  return conversationId ? calls : [];
}

/** Anchors each call after the last message sent before it, so the
 *  thread can render it in time order. Calls older than every message
 *  land under the `START` key. */
export const CALLS_START = "__start";
export function anchorCalls(
  messages: { id: string; created_at: string }[],
  calls: ThreadCall[],
): Map<string, ThreadCall[]> {
  const out = new Map<string, ThreadCall[]>();
  let i = 0;
  for (const call of calls) {
    const at = new Date(call.created_at).getTime();
    while (i < messages.length && new Date(messages[i].created_at).getTime() <= at) i++;
    const key = i === 0 ? CALLS_START : messages[i - 1].id;
    out.set(key, [...(out.get(key) ?? []), call]);
  }
  return out;
}

export function CallLogChip({ call }: { call: ThreadCall }) {
  const t = useTranslations("Calls");
  const missed = call.status === "missed" || call.status === "rejected" || call.status === "failed";
  const live = call.status === "ringing" || call.status === "accepted";
  const label = live
    ? call.status === "ringing"
      ? t("logRinging")
      : t("logLive")
    : missed
      ? call.status === "rejected"
        ? t("logRejected")
        : t("logMissed")
      : t("logAnswered", {
          duration: `${Math.floor((call.duration_seconds ?? 0) / 60)}:${String((call.duration_seconds ?? 0) % 60).padStart(2, "0")}`,
        });
  const Icon = missed ? PhoneMissed : PhoneIncoming;
  return (
    <div className="flex justify-center py-1">
      <span
        className={cn(
          "inline-flex items-center gap-1.5 rounded-full bg-muted px-3 py-1 text-[11px]",
          missed ? "text-red-500" : "text-muted-foreground",
        )}
      >
        <Icon className="h-3.5 w-3.5" />
        {label}
        <span className="opacity-70">· {format(new Date(call.created_at), "HH:mm")}</span>
      </span>
    </div>
  );
}
