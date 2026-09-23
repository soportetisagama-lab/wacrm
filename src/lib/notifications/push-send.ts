// ============================================================
// Sends a native push (FCM) to every device a user has registered
// (device_push_tokens, migration 065). No-ops silently when Firebase
// isn't configured or the user has no registered device — callers
// never need to check first, mirrors showBrowserNotification's
// "best-effort, never blocks the caller" contract on the client side.
// ============================================================

import { supabaseAdmin } from "@/lib/flows/admin-client";
import { getFirebaseMessaging } from "./firebase-admin";

interface PushPayload {
  title: string;
  body: string;
  /** Route to open on tap, e.g. `/inbox?c=<conversationId>`. */
  data?: Record<string, string>;
}

const RECIPIENT_UNREGISTERED_CODES = new Set([
  "messaging/registration-token-not-registered",
  "messaging/invalid-registration-token",
]);

export async function sendPushToUser(userId: string, payload: PushPayload): Promise<void> {
  const messaging = getFirebaseMessaging();
  if (!messaging) return;

  const admin = supabaseAdmin();
  const { data: rows, error } = await admin
    .from("device_push_tokens")
    .select("token")
    .eq("user_id", userId);

  if (error) {
    console.error("[push-send] Failed to load device tokens:", error);
    return;
  }
  const tokens = (rows ?? []).map((r) => r.token as string);
  if (tokens.length === 0) return;

  try {
    const result = await messaging.sendEachForMulticast({
      tokens,
      notification: { title: payload.title, body: payload.body },
      data: payload.data,
      android: { priority: "high" },
    });

    // Prune tokens FCM says are dead (app uninstalled, token rotated
    // without us hearing about it) — keeps the table from growing
    // stale entries we'd keep paying to fan out to forever.
    const dead: string[] = [];
    result.responses.forEach((r, i) => {
      if (!r.success && r.error && RECIPIENT_UNREGISTERED_CODES.has(r.error.code)) {
        dead.push(tokens[i]);
      }
    });
    if (dead.length > 0) {
      await admin.from("device_push_tokens").delete().in("token", dead);
    }
  } catch (err) {
    console.error("[push-send] sendEachForMulticast failed:", err);
  }
}
