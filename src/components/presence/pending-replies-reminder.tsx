"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

import { useAuth } from "@/hooks/use-auth";
import { showBrowserNotification } from "@/lib/notifications/browser-push";
import { REMINDER_EVERY_MS, pendingRepliesText } from "@/lib/notifications/pending-replies-text";

/** Shared across tabs, so several open tabs don't each fire a banner. */
const LAST_SHOWN_KEY = "wacrm:pending-replies:last-shown";
const CHECK_EVERY_MS = 60_000;

function readLastShown(): number {
  try {
    return Number(localStorage.getItem(LAST_SHOWN_KEY)) || 0;
  } catch {
    return 0;
  }
}

function writeLastShown(at: number): void {
  try {
    localStorage.setItem(LAST_SHOWN_KEY, String(at));
  } catch {
    // Best effort — worst case another tab shows the banner too.
  }
}

/**
 * PendingRepliesReminder — headless. Mount ONCE in the desktop
 * dashboard shell. Every ~10 minutes, shows a browser notification
 * with how many assigned chats the signed-in agent still has to answer
 * (business hours only — the endpoint returns 0 otherwise).
 *
 * Not mounted in the Android wrapper: the app gets the same reminder
 * as an FCM push from the flows cron (remindPendingReplies).
 */
export function PendingRepliesReminder() {
  const { user } = useAuth();
  const userId = user?.id;
  const router = useRouter();

  useEffect(() => {
    if (!userId) return;
    // The first reminder comes one interval after opening the page,
    // not on every load/reload.
    if (Date.now() - readLastShown() >= REMINDER_EVERY_MS) writeLastShown(Date.now());

    let cancelled = false;
    const tick = async () => {
      if (Date.now() - readLastShown() < REMINDER_EVERY_MS) return;
      writeLastShown(Date.now());
      try {
        const res = await fetch("/api/reminders/pending-replies", { cache: "no-store" });
        if (!res.ok || cancelled) return;
        const { count } = (await res.json()) as { count?: number };
        if (!count) return;
        const { title, body } = pendingRepliesText(count);
        showBrowserNotification(title, {
          body,
          tag: "pending-replies",
          onClick: () => router.push("/inbox"),
        });
      } catch {
        // Network blip — the next interval tries again.
      }
    };

    const timer = setInterval(tick, CHECK_EVERY_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [userId, router]);

  return null;
}
