import { NextResponse } from "next/server";
import { getCurrentAccount, toErrorResponse } from "@/lib/auth/account";
import { supabaseAdmin } from "@/lib/flows/admin-client";
import { runXlr8SyncIfDue } from "@/lib/xlr8/sync";

/** On-demand runs are still kept at least this far apart. */
const MANUAL_MIN_INTERVAL_MS = 30_000;

// Runs the xlr8 status → tag sync right away (see lib/xlr8/sync.ts).
// Fired in the background when Broadcasts or the Inbox opens, so status
// tags are fresh without waiting for the 5-minute cron pass.
export async function POST() {
  try {
    await getCurrentAccount();
  } catch (err) {
    return toErrorResponse(err);
  }

  const result = await runXlr8SyncIfDue(supabaseAdmin(), MANUAL_MIN_INTERVAL_MS);
  const changed =
    result.status === "ok" && (result.summary.agregados > 0 || result.summary.quitados > 0);
  return NextResponse.json({ ...result, changed });
}
