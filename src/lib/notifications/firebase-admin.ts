// ============================================================
// Firebase Admin — server-only, singleton. Used to send native push
// notifications via FCM to the Android wrapper app (see
// src/lib/notifications/push-send.ts for the actual send call).
//
// Credential comes from FIREBASE_SERVICE_ACCOUNT_KEY — the full
// service-account JSON as a single-line env var (never a file on
// disk; see .env.local for the convention this project already uses
// for other server secrets). Missing/unset is a valid, supported
// state (self-hosted forks that don't want push) — every caller here
// degrades to a no-op rather than throwing.
// ============================================================

import { initializeApp, getApps, cert, type App } from "firebase-admin/app";
import { getMessaging, type Messaging } from "firebase-admin/messaging";

let app: App | null | undefined;

function getFirebaseApp(): App | null {
  if (app !== undefined) return app;

  const key = process.env.FIREBASE_SERVICE_ACCOUNT_KEY;
  if (!key) {
    app = null;
    return app;
  }

  try {
    const serviceAccount = JSON.parse(key);
    app = getApps()[0] ?? initializeApp({ credential: cert(serviceAccount) });
  } catch (err) {
    console.error("[firebase-admin] Failed to initialize from FIREBASE_SERVICE_ACCOUNT_KEY:", err);
    app = null;
  }
  return app;
}

/** Null when push isn't configured (no service-account key set) — callers no-op. */
export function getFirebaseMessaging(): Messaging | null {
  const a = getFirebaseApp();
  return a ? getMessaging(a) : null;
}
