/**
 * Business-hours check for the `collect_ai` → human handoff closing
 * text (`CollectAiNodeConfig.handoff_fallback_text_after_hours`,
 * `handOffFromCollectAi` in engine.ts). Nowhere else — every other
 * node, the welcome menu, and the general auto-reply assistant keep
 * running 24/7 regardless of this.
 *
 * The model has no real clock and must never be the one deciding
 * time-sensitive wording (it would hallucinate the hour) — this is a
 * plain, pure, code-level check instead, easily unit-tested with any
 * injected `Date`.
 *
 * Peru has observed no daylight saving time since 1990 — a fixed
 * UTC-5 offset holds year-round, so this does simple arithmetic
 * rather than pulling in a timezone database (`Intl`/IANA), which
 * also means it can never behave differently depending on the host's
 * own ICU data.
 */

const PERU_UTC_OFFSET_HOURS = -5;

/** Attention hours, in minutes-since-midnight, Peru local time. */
const HOURS = {
  weekday: { start: 8 * 60, end: 17 * 60 }, // Mon-Fri 8:00am-5:00pm
  saturday: { start: 8 * 60 + 30, end: 12 * 60 + 30 }, // Sat 8:30am-12:30pm
};

/**
 * True when `now` (any instant, defaults to the current time) falls
 * within business hours: Mon-Fri 8:00am-5:00pm, Sat 8:30am-12:30pm,
 * closed Sundays. The end time is exclusive (17:00 itself is already
 * closed), matching how the range reads to a human ("until 5pm").
 */
export function isWithinBusinessHours(now: Date = new Date()): boolean {
  const peru = new Date(now.getTime() + PERU_UTC_OFFSET_HOURS * 60 * 60 * 1000);
  const day = peru.getUTCDay(); // 0=Sun..6=Sat, already shifted to Peru time
  const minutesOfDay = peru.getUTCHours() * 60 + peru.getUTCMinutes();

  if (day >= 1 && day <= 5) {
    return minutesOfDay >= HOURS.weekday.start && minutesOfDay < HOURS.weekday.end;
  }
  if (day === 6) {
    return minutesOfDay >= HOURS.saturday.start && minutesOfDay < HOURS.saturday.end;
  }
  return false; // Sunday
}
