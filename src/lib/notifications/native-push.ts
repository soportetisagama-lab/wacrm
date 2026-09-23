// ============================================================
// Native push (FCM via Capacitor) — the Android-wrapper counterpart
// to browser-push.ts. Only usable inside the wrapper (isEmbeddedApp())
// since @capacitor/push-notifications' web implementation is a stub;
// every export here is a no-op outside it.
//
// Unlike the browser Notification API, this survives the app being
// fully closed — the whole reason it exists (see browser-push.ts's
// top comment for what it replaces).
// ============================================================

import { PushNotifications, type Token, type RegistrationError } from "@capacitor/push-notifications";
import { isEmbeddedApp } from "@/lib/mobile-app";

const STORAGE_KEY = "wacrm:notifications:native:enabled";

export function isNativePushSupported(): boolean {
  return isEmbeddedApp();
}

/** Mirrors browser-push.ts's getNotificationPermission() return shape, so
 *  the notifications page can treat both mechanisms identically. */
export async function getNativePushPermission(): Promise<
  NotificationPermission | "unsupported"
> {
  if (!isNativePushSupported()) return "unsupported";
  const status = await PushNotifications.checkPermissions();
  if (status.receive === "granted") return "granted";
  if (status.receive === "denied") return "denied";
  return "default";
}

export function isNativePushEnabled(): boolean {
  if (!isNativePushSupported()) return false;
  try {
    return localStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

/**
 * Prompts for the OS permission (Android 13+ shows the system dialog;
 * older Android grants it silently), registers with FCM on success,
 * and POSTs the resulting token to /api/push/register. Resolves once
 * the token round-trip finishes (or fails) so the caller's button can
 * show a spinner the whole time, same UX as enableBrowserNotifications.
 */
export async function enableNativePush(): Promise<"granted" | "denied"> {
  if (!isNativePushSupported()) return "denied";

  const permStatus = await PushNotifications.requestPermissions();
  if (permStatus.receive !== "granted") {
    try {
      localStorage.setItem(STORAGE_KEY, "0");
    } catch {
      // best-effort
    }
    return "denied";
  }

  return new Promise((resolve) => {
    // `register()` triggers exactly one of these two listeners. Both
    // are one-shot here (`removeAllListeners` after) — a later
    // re-registration (token refresh) creates its own short-lived
    // listener pair via the same path, never accumulating handlers.
    PushNotifications.addListener("registration", async (token: Token) => {
      try {
        await fetch("/api/push/register", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token: token.value }),
        });
        localStorage.setItem(STORAGE_KEY, "1");
      } catch (err) {
        console.error("[native-push] Failed to register token:", err);
      } finally {
        await PushNotifications.removeAllListeners();
        resolve("granted");
      }
    });
    PushNotifications.addListener("registrationError", async (err: RegistrationError) => {
      console.error("[native-push] registration error:", err);
      await PushNotifications.removeAllListeners();
      resolve("denied");
    });
    PushNotifications.register();
  });
}

export function disableNativePush(): void {
  try {
    localStorage.setItem(STORAGE_KEY, "0");
  } catch {
    // best-effort — the device keeps receiving pushes server-side
    // until token cleanup, but the in-app toggle reflects "off".
  }
}
