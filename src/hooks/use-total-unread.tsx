"use client";

import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createClient } from "@/lib/supabase/client";
import type { Conversation } from "@/types";

const TotalUnreadContext = createContext<number>(0);

/**
 * Owns the single realtime subscription for the total-unread-
 * conversations count. Mount this once (dashboard-shell.tsx) —
 * `useTotalUnread` below just reads the shared value.
 *
 * Same fix as `UnreadNotificationsProvider` in
 * `use-unread-notifications.tsx`: a hook that opens its own
 * `supabase.channel(fixedName)` breaks the moment a second component
 * calls it, because the underlying supabase-js client is a singleton
 * and `RealtimeClient.channel()` reuses the channel object for a
 * topic it's already seen — a second `.on(...)` on an
 * already-`.subscribe()`d channel throws. This one is currently
 * single-consumer (only the sidebar), but fixed preventively so
 * reusing it elsewhere doesn't reintroduce the exact crash the
 * notifications count just had.
 */
export function TotalUnreadProvider({ children }: { children: ReactNode }) {
  const [total, setTotal] = useState(0);

  // Keep a live local mirror of {id: unread_count} so INSERT/UPDATE/DELETE
  // events can adjust the total in O(1) without refetching.
  const countsRef = useRef<Map<string, number>>(new Map());

  useEffect(() => {
    const supabase = createClient();
    let cancelled = false;

    // Initial load. RLS scopes this to the signed-in user automatically —
    // no explicit user_id filter needed here.
    (async () => {
      const { data, error } = await supabase
        .from("conversations")
        .select("id, unread_count");
      if (cancelled || error || !data) return;

      const map = new Map<string, number>();
      let sum = 0;
      for (const row of data as { id: string; unread_count: number }[]) {
        const n = row.unread_count ?? 0;
        map.set(row.id, n);
        if (n > 0) sum += 1;
      }
      countsRef.current = map;
      setTotal(sum);
    })();

    const channel = supabase
      .channel("total-unread-realtime")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "conversations" },
        (payload) => {
          const map = countsRef.current;
          if (payload.eventType === "DELETE") {
            const oldRow = payload.old as Partial<Conversation>;
            if (oldRow.id) map.delete(oldRow.id);
          } else {
            const row = payload.new as Conversation;
            map.set(row.id, row.unread_count ?? 0);
          }
          // Recompute — cheap, conversations per user stay small.
          let sum = 0;
          for (const n of map.values()) if (n > 0) sum += 1;
          setTotal(sum);
        },
      )
      .subscribe();

    return () => {
      cancelled = true;
      supabase.removeChannel(channel);
    };
  }, []);

  return (
    <TotalUnreadContext.Provider value={total}>
      {children}
    </TotalUnreadContext.Provider>
  );
}

/**
 * Count of conversations with at least one unread inbound message for
 * the current user. Used by the sidebar to surface a green dot on the
 * Inbox nav entry when the user is elsewhere in the app.
 *
 * Returns `0` if read outside a `TotalUnreadProvider` — a fresh count
 * is a safe resting state, not worth throwing over.
 */
export function useTotalUnread(): number {
  return useContext(TotalUnreadContext);
}
