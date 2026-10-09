"use client";

import { useSyncExternalStore } from "react";

// ============================================================
// Phone app (Android wrapper): is a chat open right now?
//
// The inbox page opens/closes a thread from local state instantly, but
// the `?c=` URL it mirrors into (router.replace) lands a moment later.
// The shell's brand header and the bottom tab bar used to key off the
// URL alone, so for that moment both screens showed at once — the
// Bandeja header stacked on top of the chat when entering it, and the
// chat still under the header when leaving.
//
// The inbox page now reports its own state here from a layout effect
// (applied before the browser paints), and the shell + tab bar read it,
// falling back to the URL when the inbox page isn't mounted (any other
// screen) — so chrome and content always flip in the same frame.
// ============================================================

let reported: boolean | null = null;
const listeners = new Set<() => void>();

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Inbox page → its thread-open state; `null` when it unmounts. */
export function reportInboxThreadOpen(open: boolean | null) {
  if (reported === open) return;
  reported = open;
  listeners.forEach((listener) => listener());
}

/** The inbox page's own state when it's mounted, else the URL's. */
export function useMobileThreadOpen(urlSaysOpen: boolean): boolean {
  const value = useSyncExternalStore(
    subscribe,
    () => reported,
    () => null
  );
  return value ?? urlSaysOpen;
}
