import { describe, expect, test } from "bun:test";
import {
  evTimestampMs,
  foldYearProjector,
  type FoldProjection,
} from "./temporal.js";

function project(tMs: number): FoldProjection {
  const result = foldYearProjector.project(tMs);
  expect(result).not.toBeNull();
  return result!;
}

function utcDateMs(
  year: number,
  month = 0,
  day = 1,
): number {
  const date = new Date(0);
  date.setUTCFullYear(year, month, day);
  date.setUTCHours(0, 0, 0, 0);
  return date.getTime();
}

describe("foldYearProjector", () => {
  test("uses stable UTC year rows and half-open boundaries", () => {
    expect(project(Date.UTC(2024, 0, 1))).toEqual({
      rowKey: "2024",
      rowIndex: 2024,
      rowLabel: "2024",
      phase0: 0,
      phase1: 0,
    });

    const last2024 = project(Date.UTC(2025, 0, 1) - 1);
    expect(last2024.rowKey).toBe("2024");
    expect(last2024.phase0).toBeGreaterThan(0);
    expect(last2024.phase0).toBeLessThan(1);

    const first2025 = project(Date.UTC(2025, 0, 1));
    expect(first2025.rowKey).toBe("2025");
    expect(first2025.phase0).toBe(0);
  });

  test("keeps leap day inside an equal-width February cell", () => {
    const feb29Noon = project(Date.UTC(2024, 1, 29, 12));
    expect(feb29Noon.phase0).toBe((1 + 28.5 / 29) / 12);
    expect(feb29Noon.phase1).toBe(feb29Noon.phase0);

    const leapMarch = project(Date.UTC(2024, 2, 1));
    const commonMarch = project(Date.UTC(2023, 2, 1));
    expect(leapMarch.phase0).toBe(2 / 12);
    expect(commonMarch.phase0).toBe(2 / 12);
  });

  test("gives every month an equal-width cell", () => {
    for (const year of [2023, 2024]) {
      for (let month = 0; month < 12; month++) {
        expect(project(Date.UTC(year, month, 1)).phase0).toBe(month / 12);
      }
    }
  });

  test("aligns the same wall date across common and leap years", () => {
    const commonFebruary = project(Date.UTC(2023, 1, 28, 12, 34, 56, 789));
    const leapFebruary = project(Date.UTC(2024, 1, 28, 12, 34, 56, 789));
    expect(leapFebruary.phase0).toBe(commonFebruary.phase0);

    const common = project(Date.UTC(2023, 6, 11, 12, 34, 56, 789));
    const leap = project(Date.UTC(2024, 6, 11, 12, 34, 56, 789));
    expect(leap.phase0).toBe(common.phase0);
  });

  test("leaves the non-leap Feb 29 slot empty", () => {
    const endOfCommonFebruary = project(Date.UTC(2023, 2, 1) - 1);
    const startOfMarch = project(Date.UTC(2023, 2, 1));
    expect(endOfCommonFebruary.phase0).toBeLessThan((1 + 28 / 29) / 12);
    expect(startOfMarch.phase0).toBe(2 / 12);
    expect(startOfMarch.phase0 - endOfCommonFebruary.phase0).toBeGreaterThan(
      1 / (29 * 12) - 1e-10,
    );
  });

  test("keeps sampled valid phases in [0, 1)", () => {
    const samples = [
      Date.UTC(1900, 0, 1),
      Date.UTC(2000, 1, 29, 23, 59, 59, 999),
      Date.UTC(2026, 6, 11, 12),
      Date.UTC(2038, 0, 19, 3, 14, 7),
      Date.UTC(2400, 11, 31, 23, 59, 59, 999),
    ];

    for (const tMs of samples) {
      const { phase0, phase1 } = project(tMs);
      expect(phase0).toBeGreaterThanOrEqual(0);
      expect(phase0).toBeLessThan(1);
      expect(phase1).toBe(phase0);
    }
  });

  test("row keys and indices do not depend on projection order", () => {
    const timestamps = [
      Date.UTC(2026, 6, 11),
      Date.UTC(2024, 1, 29),
      Date.UTC(2025, 11, 31),
    ];
    const forward = timestamps.map((tMs) => project(tMs));
    const reverse = timestamps.toReversed().map((tMs) => project(tMs)).toReversed();

    expect(reverse.map(({ rowKey }) => rowKey)).toEqual(
      forward.map(({ rowKey }) => rowKey),
    );
    expect(reverse.map(({ rowIndex }) => rowIndex)).toEqual(
      forward.map(({ rowIndex }) => rowIndex),
    );
  });

  test("does not remap UTC years 0 through 99 into the 1900s", () => {
    const year42 = project(utcDateMs(42, 6, 1));
    expect(year42.rowKey).toBe("42");
    expect(year42.rowIndex).toBe(42);
    expect(year42.phase0).toBe(6 / 12);
  });

  test("rejects non-finite and out-of-Date-range timestamps", () => {
    expect(foldYearProjector.project(Number.NaN)).toBeNull();
    expect(foldYearProjector.project(Number.POSITIVE_INFINITY)).toBeNull();
    expect(foldYearProjector.project(8.64e15 + 1)).toBeNull();
  });
});

describe("evTimestampMs", () => {
  test("accepts only explicit, Date-representable tMs values", () => {
    const tMs = Date.UTC(2026, 6, 11, 12, 34, 56, 789);
    expect(evTimestampMs({ tMs, y: 0.01 })).toBe(tMs);
    expect(evTimestampMs({ y: 0.01 })).toBeNull();
    expect(evTimestampMs({ tMs: Number.NaN })).toBeNull();
    expect(evTimestampMs({ tMs: 8.64e15 + 1 })).toBeNull();
    expect(evTimestampMs(null)).toBeNull();
  });

  test("normalizes fractional milliseconds with Date TimeClip", () => {
    expect(evTimestampMs({ tMs: 10.9 })).toBe(10);
    expect(evTimestampMs({ tMs: -10.9 })).toBe(-10);
  });
});

import { describe as describe2, expect as expect2, test as test2 } from "bun:test";
import {
  foldMonthProjector,
  foldWeekProjector,
  foldDayProjector,
  foldHourProjector,
  foldRowStartMs,
  FOLD_PERIOD_MS,
} from "./temporal.js";

describe2("finer fold projectors", () => {
  test2("month fold: max-day slots align wall days across months", () => {
    const jul11 = foldMonthProjector.project(Date.UTC(2026, 6, 11, 12))!;
    const feb11 = foldMonthProjector.project(Date.UTC(2026, 1, 11, 12))!;
    expect2(jul11.phase0).toBeCloseTo(feb11.phase0, 12); // same day-of-month → same phase
    expect2(jul11.rowKey).toBe("2026-07");
    expect2(jul11.rowIndex).toBe(2026 * 12 + 6);
    // Feb 28 in a common month leaves ghost slots 29..31 unreachable
    const feb28 = foldMonthProjector.project(Date.UTC(2026, 1, 28, 23, 59, 59))!;
    expect2(feb28.phase0).toBeLessThan(28 / 31);
  });

  test2("week fold: Monday-start rows, weekday slots, stable keys", () => {
    const mon = foldWeekProjector.project(Date.UTC(2026, 6, 6))!; // 2026-07-06 is a Monday
    expect2(mon.phase0).toBe(0);
    expect2(mon.rowKey).toBe("2026-07-06");
    const sun = foldWeekProjector.project(Date.UTC(2026, 6, 12, 23, 59))!;
    expect2(sun.rowIndex).toBe(mon.rowIndex); // same week row
    expect2(sun.phase0).toBeGreaterThan(6 / 7);
    const nextMon = foldWeekProjector.project(Date.UTC(2026, 6, 13))!;
    expect2(nextMon.rowIndex).toBe(mon.rowIndex + 1); // half-open boundary
    expect2(nextMon.phase0).toBe(0);
  });

  test2("day fold: 24 hour slots, half-open midnight", () => {
    const noon = foldDayProjector.project(Date.UTC(2026, 6, 11, 12))!;
    expect2(noon.phase0).toBeCloseTo(0.5, 12);
    expect2(noon.rowKey).toBe("2026-07-11");
    const midnight = foldDayProjector.project(Date.UTC(2026, 6, 12))!;
    expect2(midnight.phase0).toBe(0);
    expect2(midnight.rowIndex).toBe(noon.rowIndex + 1);
  });

  test2("hour fold: 60 minute slots", () => {
    const p = foldHourProjector.project(Date.UTC(2026, 6, 11, 14, 30))!;
    expect2(p.phase0).toBeCloseTo(0.5, 12);
    expect2(p.rowKey).toBe("07-11 14:00");
  });

  test2("foldRowStartMs inverts rowIndex for every fold", () => {
    const t = Date.UTC(2026, 6, 11, 14, 30, 15);
    for (const proj of [foldMonthProjector, foldWeekProjector, foldDayProjector, foldHourProjector]) {
      const p = proj.project(t)!;
      const start = foldRowStartMs(proj.id, p.rowIndex);
      expect2(proj.project(start)!.rowIndex).toBe(p.rowIndex);
      expect2(proj.project(start)!.phase0).toBe(0);
      expect2(proj.project(start - 1)!.rowIndex).toBe(p.rowIndex - 1);
    }
    // year uses the setUTCFullYear guard: year 42 stays year 42
    expect2(new Date(foldRowStartMs("year", 42)).getUTCFullYear()).toBe(42);
  });

  test2("FOLD_PERIOD_MS descends through the ladder", () => {
    const order = ["year", "month", "week", "day", "hour"];
    for (let i = 1; i < order.length; i++) {
      expect2(FOLD_PERIOD_MS[order[i]!]!).toBeLessThan(FOLD_PERIOD_MS[order[i - 1]!]!);
    }
  });
});
