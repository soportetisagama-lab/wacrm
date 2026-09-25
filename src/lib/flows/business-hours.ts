/**
 * Business-hours check (and the `{proxima_apertura}` placeholder) for
 * the `collect_ai` → human handoff closing text (`CollectAiNodeConfig.handoff_fallback_text_after_hours`,
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
  monToThu: { start: 8 * 60, end: 17 * 60 }, // Mon-Thu 8:00am-5:00pm
  friday: { start: 8 * 60, end: 17 * 60 + 30 }, // Fri 8:00am-5:30pm
  saturday: { start: 8 * 60 + 30, end: 12 * 60 + 30 }, // Sat 8:30am-12:30pm
};

/** Attention window for a Peru-local weekday (0=Sun..6=Sat), or null when closed. */
function windowForDay(day: number): { start: number; end: number } | null {
  if (day >= 1 && day <= 4) return HOURS.monToThu;
  if (day === 5) return HOURS.friday;
  if (day === 6) return HOURS.saturday;
  return null; // Sunday
}

/** `now` shifted to Peru wall-clock time, read back through the UTC getters. */
function peruClock(now: Date): { day: number; minutesOfDay: number } {
  const peru = new Date(now.getTime() + PERU_UTC_OFFSET_HOURS * 60 * 60 * 1000);
  return {
    day: peru.getUTCDay(), // 0=Sun..6=Sat, already shifted to Peru time
    minutesOfDay: peru.getUTCHours() * 60 + peru.getUTCMinutes(),
  };
}

/**
 * True when `now` (any instant, defaults to the current time) falls
 * within business hours: Mon-Thu 8:00am-5:00pm, Fri 8:00am-5:30pm,
 * Sat 8:30am-12:30pm, closed Sundays. The end time is exclusive
 * (17:00 itself is already closed), matching how the range reads to
 * a human ("until 5pm").
 */
export function isWithinBusinessHours(now: Date = new Date()): boolean {
  const { day, minutesOfDay } = peruClock(now);
  const window = windowForDay(day);
  return window !== null && minutesOfDay >= window.start && minutesOfDay < window.end;
}

/**
 * Placeholder an author can put in any after-hours text (collect_ai
 * `handoff_fallback_text_after_hours`, handoff `customer_message_after_hours`,
 * list/buttons `reprompt_hint_text_after_hours`). Replaced at send time
 * with `nextOpeningPhrase()` — a fixed "mañana a primera hora" was wrong
 * before opening ("hoy") and on Saturday afternoons ("el lunes").
 */
export const NEXT_OPENING_PLACEHOLDER = "{proxima_apertura}";

const DAY_NAMES = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"];

function formatTime(minutesOfDay: number): string {
  const h24 = Math.floor(minutesOfDay / 60);
  const minutes = String(minutesOfDay % 60).padStart(2, "0");
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${h12}:${minutes} ${h24 < 12 ? "am" : "pm"}`;
}

/**
 * When the business next opens, as a phrase that reads naturally
 * mid-sentence: "hoy a las 8:00 am", "mañana a las 8:00 am",
 * "mañana sábado a las 8:30 am", "el lunes a las 8:00 am". Always the
 * next opening strictly after `now` — only meaningful while closed,
 * which is the only time the after-hours texts are sent.
 */
export function nextOpeningPhrase(now: Date = new Date()): string {
  const { day, minutesOfDay } = peruClock(now);
  for (let offset = 0; offset <= 7; offset++) {
    const d = (day + offset) % 7;
    const window = windowForDay(d);
    if (!window) continue;
    // Today's window already opened (open now, or closed for the day).
    if (offset === 0 && minutesOfDay >= window.start) continue;
    const time = formatTime(window.start);
    if (offset === 0) return `hoy a las ${time}`;
    if (offset === 1) {
      // Name the day when "mañana" alone could mislead: Saturday's
      // shorter hours, and Monday right after a closed Sunday.
      return d === 1 || d === 6
        ? `mañana ${DAY_NAMES[d]} a las ${time}`
        : `mañana a las ${time}`;
    }
    return `el ${DAY_NAMES[d]} a las ${time}`;
  }
  return "apenas volvamos a abrir"; // unreachable while any day has hours
}

/** Replaces every NEXT_OPENING_PLACEHOLDER in `text`; text without it is returned unchanged. */
export function fillBusinessHoursPlaceholders(text: string, now: Date = new Date()): string {
  return text.includes(NEXT_OPENING_PLACEHOLDER)
    ? text.replaceAll(NEXT_OPENING_PLACEHOLDER, nextOpeningPhrase(now))
    : text;
}
