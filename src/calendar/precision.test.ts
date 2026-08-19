import { describe, expect, test } from "bun:test";
import { durationMs, precisionUnit, spanYears } from "./precision.js";
import { precisionWindow } from "../lane/temporal.js";

const MONTH = { allDay: true, precision: "month" } as const;
const ALLDAY = { allDay: true } as const;
const TIMED = { allDay: false } as const;
const DAY = 86400_000;

describe("calendar precision", () => {
  test("a month-precision event reports the month, not the day it starts on", () => {
    expect(precisionUnit(MONTH)).toBe("month");
  });

  test("ordinary all-day and timed events keep day / minute", () => {
    // Without this the feature could be implemented by returning "month"
    // always, which every month test above would still pass.
    expect(precisionUnit(ALLDAY)).toBe("day");
    expect(precisionUnit(TIMED)).toBe("minute");
  });

  test("a month-precision event asserts no duration, however long its span", () => {
    expect(durationMs(MONTH, 31 * DAY)).toBeUndefined();
  });

  test("a genuinely month-long all-day event DOES assert its duration", () => {
    // The pair is the whole point: identical spans, opposite answers. Shape
    // cannot tell them apart, so only the declared precision can.
    expect(durationMs(ALLDAY, 31 * DAY)).toBe(31 * DAY);
  });

  test("a single-day all-day event still asserts none (pre-existing rule)", () => {
    expect(durationMs(ALLDAY, DAY)).toBeUndefined();
  });

  test("a timed event keeps its duration", () => {
    expect(durationMs(TIMED, 3600_000)).toBe(3600_000);
  });

  test("a month-precision event's fuzzy band is half a month, not a minute", () => {
    const minute = 1 / 365.25 / 1440;
    expect(spanYears(MONTH, minute)).toBeCloseTo(15.22 / 365.25, 6);
  });

  test("everything else keeps the caller's default span", () => {
    // Pins the deliberate narrowness of the change: widening ordinary all-day
    // events would move every existing calendar, and nothing asked for that.
    const minute = 1 / 365.25 / 1440;
    expect(spanYears(ALLDAY, minute)).toBe(minute);
    expect(spanYears(TIMED, minute)).toBe(minute);
  });

  test("month unit resolves to the containing calendar month", () => {
    // Ties this module to the renderer's LOD input: `classifyEv` opens the soft
    // window from precisionWindow(), so a unit that produced no window would
    // silently fall back to a crisp point.
    expect(
      precisionWindow({ tMs: Date.UTC(2027, 2, 1), precision: { kind: "calendar", unit: "month" } }),
    ).toEqual([Date.UTC(2027, 2, 1), Date.UTC(2027, 3, 1)]);
  });
});
