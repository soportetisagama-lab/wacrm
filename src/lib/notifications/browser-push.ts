/**
 * Thin wrapper around the standard Web Notification API — shows an
 * OS-level banner (desktop browser, or the Android WebView process,
 * while the app is running) when a new message or a handoff/assignment
 * arrives. This is NOT native push: it can't wake up a fully closed
 * app. True background push would need FCM + a Firebase project, which
 * is a separate, deliberately out-of-scope follow-up.
 *
 * Gated behind an explicit per-device opt-in (`STORAGE_KEY`), separate
 * from the OS permission itself — a user can grant the browser
 * permission once and still turn the in-app toggle off later without
 * re-prompting.
 */

const STORAGE_KEY = "wacrm:notifications:enabled";

export function isBrowserNotificationSupported(): boolean {
  return typeof window !== "undefined" && "Notification" in window;
}

export function getNotificationPermission(): NotificationPermission | "unsupported" {
  if (!isBrowserNotificationSupported()) return "unsupported";
  return Notification.permission;
}

/** Whether the user has both granted the OS permission AND left the in-app toggle on. */
export function isNotificationEnabled(): boolean {
  if (!isBrowserNotificationSupported()) return false;
  if (Notification.permission !== "granted") return false;
  try {
    return localStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

/** Prompts for OS permission (only actually prompts the first time) and flips the in-app toggle on if granted. */
export async function enableBrowserNotifications(): Promise<NotificationPermission> {
  if (!isBrowserNotificationSupported()) return "denied";
  const permission = await Notification.requestPermission();
  try {
    localStorage.setItem(STORAGE_KEY, permission === "granted" ? "1" : "0");
  } catch {
    // Persistence is best-effort — the permission itself still sticks.
  }
  return permission;
}

/** Flips the in-app toggle off. Does not revoke the OS permission (browsers don't allow that from JS). */
export function disableBrowserNotifications(): void {
  try {
    localStorage.setItem(STORAGE_KEY, "0");
  } catch {
    // Ignore — best effort.
  }
}

interface ShowNotificationOptions {
  body?: string;
  tag?: string;
  onClick?: () => void;
}

/** No-ops silently if unsupported, not permitted, or the user has the toggle off — callers never need to check first. */
export function showBrowserNotification(title: string, { body, tag, onClick }: ShowNotificationOptions = {}): void {
  if (!isNotificationEnabled()) return;
  try {
    const n = new Notification(title, {
      body,
      tag,
      // Cache-busted: browsers/Windows Action Center cache a Notification's
      // icon quite persistently, sometimes surviving a normal page reload —
      // bump this version whenever the underlying image file changes so
      // viewers actually see the new one instead of a stale cached copy.
      icon: "/branding/icon-square.png?v=2",
    });
    if (onClick) {
      n.onclick = () => {
        window.focus();
        onClick();
        n.close();
      };
    }
  } catch {
    // Notification construction can throw in some embedded WebViews
    // even when `Notification.permission === "granted"` — never let a
    // best-effort banner take down the caller.
  }
}
