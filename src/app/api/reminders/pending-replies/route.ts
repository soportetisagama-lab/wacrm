import { NextResponse } from "next/server";
import { getCurrentAccount, toErrorResponse } from "@/lib/auth/account";
import { supabaseAdmin } from "@/lib/flows/admin-client";
import { isWithinBusinessHours } from "@/lib/flows/business-hours";
import { countPendingReplies } from "@/lib/notifications/pending-replies";

// How many assigned chats the signed-in agent still has to answer —
// polled by the web's PendingRepliesReminder. Always 0 outside
// business hours, so the reminder stays quiet then.
export async function GET() {
  let ctx;
  try {
    ctx = await getCurrentAccount();
  } catch (err) {
    return toErrorResponse(err);
  }

  if (!isWithinBusinessHours()) return NextResponse.json({ count: 0 });

  try {
    const counts = await countPendingReplies(supabaseAdmin(), { agentId: ctx.userId });
    return NextResponse.json({ count: counts.get(ctx.userId) ?? 0 });
  } catch (err) {
    console.error("[reminders] pending-replies count failed:", err);
    return NextResponse.json({ error: "count failed" }, { status: 500 });
  }
}
