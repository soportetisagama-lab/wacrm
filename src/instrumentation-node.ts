import { internalCronState } from "@/lib/cron/internal";

// Calls this server's own /api/flows/cron every minute (nudges,
// timeouts, debounce recovery, pending-reply reminders) — see
// src/lib/cron/internal.ts for why and how it avoids double runs.

const EVERY_MS = 60_000;
/** An external pinger that ran this recently already covered this minute. */
const RECENT_RUN_MS = 50_000;

const state = internalCronState();
const port = process.env.PORT || "3000";

setInterval(async () => {
  if (state.flowsRunning || Date.now() - state.flowsLastStartedAt < RECENT_RUN_MS) return;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/flows/cron`, {
      headers: { "x-cron-secret": state.secret },
      cache: "no-store",
    });
    if (!res.ok) console.error("[internal-cron] flows cron returned", res.status);
  } catch (err) {
    console.error("[internal-cron] flows cron call failed:", err);
  }
}, EVERY_MS).unref();
