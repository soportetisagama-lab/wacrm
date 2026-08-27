"use client";

import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { createClient } from "@/lib/supabase/client";
import type { Notification } from "@/types";

const UnreadNotificationsContext = createContext<number>(0);

/**
 * Owns the single realtime subscription for the unread-notifications
 * count. Mount this once (dashboard-shell.tsx, alongside the sidebar
 * and header) — `useUnreadNotifications` below just reads the shared
 * value.
 *
 * This used to live inline inside the hook, with every call site
 * opening its own `supabase.channel("notifications-unread-count")`.
 * That broke the moment two components used the hook at once: the
 * underlying supabase-js client is itself a singleton
 * (`@/lib/supabase/client`), and `RealtimeClient.channel()` returns
 * the *same* channel object for a topic name it's already seen rather
 * than creating a second one. The second hook instance's `.on(...)`
 * call then landed on a channel the first instance had already
 * `.subscribe()`d, which throws ("cannot add postgres_changes
 * callbacks ... after subscribe()") — exactly what happened when the
 * header grew its own notification bell alongside the sidebar's nav
 * item. One subscription behind a Provider sidesteps the whole class
 * of bug instead of just dodging this one instance of it.
 */
export function UnreadNotificationsProvider({
  children,
}: {
  children: ReactNode;
}) {
  const [count, setCount] = useState(0);

  useEffect(() => {
    const supabase = createClient();
    let cancelled = false;

    (async () => {
      // head:true skips fetching rows — we only need the `count`
      // supabase-js returns alongside the (empty) response body.
      const { count: unreadCount, error } = await supabase
        .from("notifications")
        .select("*", { count: "exact", head: true })
        .is("read_at", null);
      if (cancelled || error) return;
      setCount(unreadCount ?? 0);
    })();

    const channel = supabase
      .channel("notifications-unread-count")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "notifications" },
        (payload) => {
          if (payload.eventType === "INSERT") {
            const row = payload.new as Notification;
            if (!row.read_at) setCount((n) => n + 1);
          } else if (payload.eventType === "UPDATE") {
            // Updates here only ever set read_at (marking a notification
            // read). Derive purely from the new row so we don't rely on
            // payload.old columns, which require REPLICA IDENTITY FULL.
            const newRow = payload.new as Notification;
            if (newRow.read_at) setCount((n) => Math.max(0, n - 1));
          } else if (payload.eventType === "DELETE") {
            const oldRow = payload.old as Partial<Notification>;
            if (!oldRow.read_at) setCount((n) => Math.max(0, n - 1));
          }
        },
      )
      .subscribe();

    return () => {
      cancelled = true;
      supabase.removeChannel(channel);
    };
  }, []);

  return (
    <UnreadNotificationsContext.Provider value={count}>
      {children}
    </UnreadNotificationsContext.Provider>
  );
}

/**
 * Count of unread notifications for the current user. Used by the
 * sidebar's Notifications nav entry and the header's bell.
 *
 * Returns `0` if read outside an `UnreadNotificationsProvider` —
 * a fresh count is a safe resting state, not worth throwing over.
 */
export function useUnreadNotifications(): number {
  return useContext(UnreadNotificationsContext);
}
