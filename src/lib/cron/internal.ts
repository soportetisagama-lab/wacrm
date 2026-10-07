import { randomBytes, timingSafeEqual } from "node:crypto";

// ============================================================
// In-process scheduler for /api/flows/cron (started from
// src/instrumentation-node.ts), so a line works without an external
// pinger. Kept on globalThis because instrumentation and the route
// handler are bundled separately but share the Node process.
//
// Lines that also have an external pinger don't double-run: the route
// skips while a run is in progress, and the in-process tick skips when
// any run (external or its own) started less than a minute ago.
// ============================================================

interface InternalCronState {
  /** Random per-process secret the in-process tick authenticates with —
   *  works even when AUTOMATION_CRON_SECRET isn't set. */
  secret: string;
  flowsRunning: boolean;
  flowsLastStartedAt: number;
}

const g = globalThis as { __wacrmInternalCron?: InternalCronState };

export function internalCronState(): InternalCronState {
  g.__wacrmInternalCron ??= {
    secret: randomBytes(32).toString("hex"),
    flowsRunning: false,
    flowsLastStartedAt: 0,
  };
  return g.__wacrmInternalCron;
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/** True for AUTOMATION_CRON_SECRET (external pinger) or the in-process secret. */
export function isAuthorizedCronSecret(supplied: string): boolean {
  if (!supplied) return false;
  const expected = process.env.AUTOMATION_CRON_SECRET;
  if (expected && safeEqual(supplied, expected)) return true;
  return safeEqual(supplied, internalCronState().secret);
}
