"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";

import { createClient } from "@/lib/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { showBrowserNotification } from "@/lib/notifications/browser-push";
import type { Message } from "@/types";

/**
 * AssignedMessageNotifier — headless. Mount ONCE in the desktop dashboard
 * shell. Shows a browser notification when a customer writes in a
 * conversation assigned to the signed-in user, on ANY dashboard page —
 * the inbox page's own notifier only runs while /inbox is mounted, and
 * skips the open conversation even when the tab is in the background.
 *
 * Only the assignee is paged here; everyone else (ATC, supervisors)
 * keeps the inbox page's existing behaviour, which defers to this
 * component for conversations assigned to the viewer so nobody gets the
 * same banner twice.
 *
 * Not mounted in the Android wrapper: the assignee already gets an FCM
 * push there (webhook → sendPushToUser).
 */
export function AssignedMessageNotifier() {
  const { user } = useAuth();
  const userId = user?.id;
  const router = useRouter();
  const t = useTranslations("Inbox.page");
  // A plain string dep, so a new `t` identity never resubscribes the channel.
  const fallbackTitle = t("newMessageFallbackTitle");

  useEffect(() => {
    if (!userId) return;
    const supabase = createClient();

    const channel = supabase
      .channel("assigned-message-notifier")
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "messages" },
        async (payload) => {
          const msg = payload.new as Message;
          if (msg.sender_type !== "customer") return;

          // Actually looking at this conversation right now → no banner.
          const params = new URLSearchParams(window.location.search);
          const viewingIt =
            window.location.pathname === "/inbox" &&
            params.get("c") === msg.conversation_id &&
            document.visibilityState === "visible" &&
            document.hasFocus();
          if (viewingIt) return;

          const { data: conv } = await supabase
            .from("conversations")
            .select("assigned_agent_id, contact:contacts(name, phone)")
            .eq("id", msg.conversation_id)
            .maybeSingle();
          if (!conv || conv.assigned_agent_id !== userId) return;

          const contact = (Array.isArray(conv.contact) ? conv.contact[0] : conv.contact) as
            | { name: string | null; phone: string | null }
            | null
            | undefined;
          showBrowserNotification(
            contact?.name || contact?.phone || fallbackTitle,
            {
              body: msg.content_text || undefined,
              // Same tag as the inbox page's notifier so the OS collapses
              // a burst of messages from one chat into a single banner.
              tag: `message-${msg.conversation_id}`,
              onClick: () => router.push(`/inbox?c=${msg.conversation_id}`),
            },
          );
        },
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [userId, router, fallbackTitle]);

  return null;
}
