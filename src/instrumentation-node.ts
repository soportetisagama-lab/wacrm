import { internalCronState } from "@/lib/cron/internal";

// Calls this server's own /api/flows/cron every minute (nudges,
// timeouts, debounce recovery, pending-reply reminders) — see
// src/lib/cron/internal.ts for why and how it avoids double runs.

const EVERY_MS = 60_000;
/** An external pinger that ran this recently already covered this minute. */
const RECENT_RUN_MS = 50_000;
/** First broadcast sweep after boot, once the server accepts requests. */
const BROADCAST_BOOT_DELAY_MS = 15_000;

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

// Broadcasts are sent by a server worker (lib/broadcasts/server-worker).
// At boot and then every minute, retake the ones whose worker died
// (restart, deploy, crash) once their lease heartbeat has expired.
async function sweepBroadcasts() {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/broadcasts/worker`, {
      method: "POST",
      headers: { "x-cron-secret": state.secret },
      cache: "no-store",
    });
    if (!res.ok) console.error("[internal-cron] broadcast sweep returned", res.status);
  } catch (err) {
    console.error("[internal-cron] broadcast sweep call failed:", err);
  }
}

setTimeout(sweepBroadcasts, BROADCAST_BOOT_DELAY_MS).unref();
setInterval(sweepBroadcasts, EVERY_MS).unref();
