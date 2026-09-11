import { describe, it, expect } from "vitest";
import { isWithinBusinessHours } from "./business-hours";

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

  it("Friday 4:59pm Peru — one minute before closing", () => {
    expect(isWithinBusinessHours(new Date("2024-01-05T21:59:00Z"))).toBe(true);
  });

  it("Friday 5:00pm Peru — closing time itself is already closed (end exclusive)", () => {
    expect(isWithinBusinessHours(new Date("2024-01-05T22:00:00Z"))).toBe(false);
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
