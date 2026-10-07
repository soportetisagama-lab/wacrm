// ============================================================
// "Te faltan responder N chats" reminder. A chat counts when it's
// open/pending, assigned to an agent, and the customer's latest
// message is newer than the latest AGENT message — bot replies
// (welcome menu, "un asesor te contactará") don't count as answered,
// the customer is still waiting for a person.
//
// Sent every REMINDER_EVERY_MS during business hours: as an FCM push
// to the app (flows cron → remindPendingReplies) and as a browser
// notification on the web (PendingRepliesReminder → /api/reminders/
// pending-replies, which reuses countPendingReplies).
// ============================================================

import type { SupabaseClient } from "@supabase/supabase-js";
import { isWithinBusinessHours } from "@/lib/flows/business-hours";
import { sendPushToUser } from "./push-send";
import { REMINDER_EVERY_MS, pendingRepliesText } from "./pending-replies-text";

/** Chats whose last activity is older than this are left out — an
 *  abandoned chat from weeks ago isn't what the reminder is about. */
const LOOKBACK_MS = 7 * 24 * 60 * 60_000;
const ID_CHUNK = 100;

/** Pending-reply count per assigned agent (agents with 0 are absent).
 *  Pass `agentId` to count a single agent's chats only. */
export async function countPendingReplies(
  db: SupabaseClient,
  opts: { agentId?: string; now?: Date } = {},
): Promise<Map<string, number>> {
  const since = new Date((opts.now ?? new Date()).getTime() - LOOKBACK_MS).toISOString();

  let query = db
    .from("conversations")
    .select("id, assigned_agent_id")
    .in("status", ["open", "pending"])
    .not("assigned_agent_id", "is", null)
    .gte("last_message_at", since);
  if (opts.agentId) query = query.eq("assigned_agent_id", opts.agentId);
  const { data: convs, error } = await query;
  if (error) throw error;

  const agentByConv = new Map<string, string>();
  for (const c of (convs ?? []) as { id: string; assigned_agent_id: string }[]) {
    agentByConv.set(c.id, c.assigned_agent_id);
  }

  const counts = new Map<string, number>();
  const ids = [...agentByConv.keys()];
  for (let i = 0; i < ids.length; i += ID_CHUNK) {
    const chunk = ids.slice(i, i + ID_CHUNK);
    const { data: msgs, error: msgErr } = await db
      .from("messages")
      .select("conversation_id, sender_type")
      .in("conversation_id", chunk)
      .in("sender_type", ["customer", "agent"])
      .gte("created_at", since)
      .order("created_at", { ascending: false });
    if (msgErr) throw msgErr;

    // Newest first, so the first row seen per conversation decides it.
    const decided = new Set<string>();
    for (const m of (msgs ?? []) as { conversation_id: string; sender_type: string }[]) {
      if (decided.has(m.conversation_id)) continue;
      decided.add(m.conversation_id);
      if (m.sender_type !== "customer") continue;
      const agent = agentByConv.get(m.conversation_id)!;
      counts.set(agent, (counts.get(agent) ?? 0) + 1);
    }
  }
  return counts;
}

let lastPushRunAt = 0;

/**
 * Push the reminder to every agent with pending chats, at most once
 * per REMINDER_EVERY_MS however often the cron calls this. Business
 * hours only. Best-effort — never throws.
 */
export async function remindPendingReplies(db: SupabaseClient, now: Date = new Date()): Promise<number> {
  if (!isWithinBusinessHours(now)) return 0;
  // A little slack so a cron firing every few minutes doesn't skip a
  // whole extra interval over a few seconds of drift.
  if (now.getTime() - lastPushRunAt < REMINDER_EVERY_MS - 30_000) return 0;
  lastPushRunAt = now.getTime();

  try {
    const counts = await countPendingReplies(db, { now });
    await Promise.all(
      [...counts].map(([agentId, count]) =>
        sendPushToUser(agentId, pendingRepliesText(count)),
      ),
    );
    return counts.size;
  } catch (err) {
    console.error("[pending-replies] reminder failed:", err);
    return 0;
  }
}

/** Test-only: forget the push throttle. */
export function resetPendingRepliesReminder(): void {
  lastPushRunAt = 0;
}
