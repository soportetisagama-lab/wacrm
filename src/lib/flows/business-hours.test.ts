import { describe, it, expect } from "vitest";
import {
  isWithinBusinessHours,
  nextOpeningPhrase,
  fillBusinessHoursPlaceholders,
} from "./business-hours";

// Reference week (2024-01-01 was a Monday): Mon Jan 1 .. Sun Jan 7.
// Peru is UTC-5 year-round (no DST), so Peru local time = UTC - 5h,
// i.e. UTC = Peru + 5h — every fixture below is built that way.
describe("isWithinBusinessHours", () => {
  it("Monday 8:00am Peru — start of the weekday window, inclusive", () => {
    expect(isWithinBusinessHours(new Date("2024-01-01T13:00:00Z"))).toBe(true);
  });

  it("Monday 7:59am Peru — one minute before opening", () => {
    expect(isWithinBusinessHours(new Date("2024-01-01T12:59:00Z"))).toBe(false);
  });

  it("Monday noon Peru — comfortably within the weekday window", () => {
    expect(isWithinBusinessHours(new Date("2024-01-01T17:00:00Z"))).toBe(true);
  });

  it("Thursday 4:59pm Peru — one minute before Mon-Thu closing", () => {
    expect(isWithinBusinessHours(new Date("2024-01-04T21:59:00Z"))).toBe(true);
  });

  it("Thursday 5:00pm Peru — Mon-Thu closes at 5pm, not Friday's 5:30 (end exclusive)", () => {
    expect(isWithinBusinessHours(new Date("2024-01-04T22:00:00Z"))).toBe(false);
  });

  it("Friday 5:00pm Peru — still open, Friday's window runs later than Mon-Thu", () => {
    expect(isWithinBusinessHours(new Date("2024-01-05T22:00:00Z"))).toBe(true);
  });

  it("Friday 5:29pm Peru — one minute before Friday's later closing", () => {
    expect(isWithinBusinessHours(new Date("2024-01-05T22:29:00Z"))).toBe(true);
  });

  it("Friday 5:30pm Peru — closing time itself is already closed (end exclusive)", () => {
    expect(isWithinBusinessHours(new Date("2024-01-05T22:30:00Z"))).toBe(false);
  });

  it("Saturday 8:29am Peru — before the shorter Saturday window opens", () => {
    expect(isWithinBusinessHours(new Date("2024-01-06T13:29:00Z"))).toBe(false);
  });

  it("Saturday 8:30am Peru — start of the Saturday window, inclusive", () => {
    expect(isWithinBusinessHours(new Date("2024-01-06T13:30:00Z"))).toBe(true);
  });

  it("Saturday 12:29pm Peru — one minute before the Saturday window closes", () => {
    expect(isWithinBusinessHours(new Date("2024-01-06T17:29:00Z"))).toBe(true);
  });

  it("Saturday 12:30pm Peru — Saturday closes at 12:30, not 5pm like weekdays", () => {
    expect(isWithinBusinessHours(new Date("2024-01-06T17:30:00Z"))).toBe(false);
  });

  it("Sunday, any time — closed all day", () => {
    expect(isWithinBusinessHours(new Date("2024-01-07T15:00:00Z"))).toBe(false);
    expect(isWithinBusinessHours(new Date("2024-01-07T20:00:00Z"))).toBe(false);
  });

  it("shifts the calendar day, not just the clock — UTC already Monday but still Sunday night in Peru", () => {
    // 2024-01-08T01:00:00Z is UTC Monday 1am, but Peru local time is
    // 2024-01-07 (Sunday) 8pm — must read as Sunday, not Monday.
    expect(isWithinBusinessHours(new Date("2024-01-08T01:00:00Z"))).toBe(false);
  });

  it("shifts the calendar day the other way too — UTC still Monday but already Sunday-into-Monday midnight crossed backward", () => {
    // 2024-01-01T02:00:00Z is UTC Monday 2am, but Peru local time is
    // 2023-12-31 (Sunday) 9pm — must read as Sunday (closed), not
    // Monday's 8:30-17:00 window.
    expect(isWithinBusinessHours(new Date("2024-01-01T02:00:00Z"))).toBe(false);
  });

  it("defaults to the current time when no argument is given", () => {
    expect(() => isWithinBusinessHours()).not.toThrow();
  });
});

// Same reference week: Mon 2024-01-01 .. Sun 2024-01-07, UTC = Peru + 5h.
describe("nextOpeningPhrase", () => {
  it("Tuesday 7:00am — opens later today", () => {
    expect(nextOpeningPhrase(new Date("2024-01-02T12:00:00Z"))).toBe("hoy a las 8:00 am");
  });

  it("Tuesday 8:00pm — opens tomorrow", () => {
    expect(nextOpeningPhrase(new Date("2024-01-03T01:00:00Z"))).toBe("mañana a las 8:00 am");
  });

  it("Friday 7:00pm — names Saturday and its later opening", () => {
    expect(nextOpeningPhrase(new Date("2024-01-06T00:00:00Z"))).toBe("mañana sábado a las 8:30 am");
  });

  it("Saturday 7:00am — Saturday opens at 8:30", () => {
    expect(nextOpeningPhrase(new Date("2024-01-06T12:00:00Z"))).toBe("hoy a las 8:30 am");
  });

  it("Saturday 3:00pm — skips the closed Sunday", () => {
    expect(nextOpeningPhrase(new Date("2024-01-06T20:00:00Z"))).toBe("el lunes a las 8:00 am");
  });

  it("Sunday noon — names Monday", () => {
    expect(nextOpeningPhrase(new Date("2024-01-07T17:00:00Z"))).toBe("mañana lunes a las 8:00 am");
  });
});

describe("fillBusinessHoursPlaceholders", () => {
  it("replaces the placeholder", () => {
    expect(
      fillBusinessHoursPlaceholders(
        "Un asesor te escribe {proxima_apertura}.",
        new Date("2024-01-02T12:00:00Z"),
      ),
    ).toBe("Un asesor te escribe hoy a las 8:00 am.");
  });

  it("leaves text without the placeholder untouched", () => {
    expect(fillBusinessHoursPlaceholders("Sin cambios.")).toBe("Sin cambios.");
  });
});
