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
