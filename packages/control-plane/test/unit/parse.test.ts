import { describe, expect, it } from "vitest";
import { localToUtcIso, parseAmount, parseCallbackTime, parseRelativeDate } from "../../src/index.js";

const today = "2026-08-16"; // Sunday

describe("parseRelativeDate (borrower-local calendar)", () => {
  it.each([
    ["I can pay tomorrow", "2026-08-17"],
    ["on Friday", "2026-08-21"],
    ["sunday works", "2026-08-23"], // said on a Sunday => next Sunday
    ["next week", "2026-08-23"],
    ["in 3 days", "2026-08-19"],
    ["in two days", "2026-08-18"],
    ["by the 25th", "2026-08-25"],
    ["by the 5th", "2026-09-05"], // already past this month
    ["end of the month", "2026-08-31"],
    ["2026-09-01 is fine", "2026-09-01"],
    ["I have no idea", null],
  ])("%s -> %s", (text, expected) => {
    expect(parseRelativeDate(text, today)).toBe(expected);
  });
});

describe("parseAmount", () => {
  it.each([
    ["I can pay 550 on Friday", "550.00"],
    ["$1,200 by next week", "1200.00"],
    ["two hundred dollars", "200.00"],
    ["five hundred fifty", "550.00"],
    ["one thousand two hundred", "1200.00"],
    ["I'll pay by the 15th", null], // ordinal, not an amount
    ["call me tomorrow", null],
  ])("%s -> %s", (text, expected) => {
    expect(parseAmount(text)).toBe(expected);
  });
});

describe("parseCallbackTime + localToUtcIso", () => {
  it("tomorrow at 3pm in New York (EDT) is 19:00Z", () => {
    const t = parseCallbackTime("call me back tomorrow at 3pm", today);
    expect(t).toEqual({ isoDate: "2026-08-17", hour: 15, minute: 0 });
    expect(localToUtcIso(t.isoDate, t.hour, t.minute, "America/New_York")).toBe("2026-08-17T19:00:00Z");
  });
  it("defaults to 10:00 local tomorrow; 'in the morning' also 10:00; IST offset applied", () => {
    const t = parseCallbackTime("just call me back", today);
    expect(t).toEqual({ isoDate: "2026-08-17", hour: 10, minute: 0 });
    expect(localToUtcIso("2026-08-17", 10, 0, "Asia/Kolkata")).toBe("2026-08-17T04:30:00Z");
    expect(parseCallbackTime("call me tomorrow in the afternoon", today).hour).toBe(15);
  });
});
