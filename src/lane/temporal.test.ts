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
  foldDecadeProjector,
  foldCenturyProjector,
  foldMillenniumProjector,
  foldWeekProjector,
  foldDayProjector,
  foldHourProjector,
  foldRowStartMs,
  FOLD_PERIOD_MS,
  precisionWindow,
  projectWindow,
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
    const order = ["millennium", "century", "decade", "year", "month", "week", "day", "hour"];
    for (let i = 1; i < order.length; i++) {
      expect2(FOLD_PERIOD_MS[order[i]!]!).toBeLessThan(FOLD_PERIOD_MS[order[i - 1]!]!);
    }
  });
});

describe2("decimal year fold projectors", () => {
  test2("flips rows at decimal boundaries", () => {
    const y1999 = foldDecadeProjector.project(utcDateMs(1999, 11, 31))!;
    const y2000 = foldDecadeProjector.project(utcDateMs(2000))!;
    expect2(y1999.rowIndex).toBe(199);
    expect2(y1999.rowKey).toBe("1990s");
    expect2(y2000.rowIndex).toBe(200);
    expect2(y2000.rowKey).toBe("2000s");
    expect2(y2000.phase0).toBe(0);

    expect2(foldCenturyProjector.project(utcDateMs(1999))!.rowKey).toBe("1900s");
    expect2(foldCenturyProjector.project(utcDateMs(2000))!.rowKey).toBe("2000s");
    expect2(foldMillenniumProjector.project(utcDateMs(999, 11, 31))!.rowKey).toBe("0s");
    expect2(foldMillenniumProjector.project(utcDateMs(1000))!.rowKey).toBe("1000s");
  });

  test2("uses floor semantics for zero and negative years", () => {
    const zero = foldDecadeProjector.project(utcDateMs(0))!;
    const nine = foldDecadeProjector.project(utcDateMs(9, 11, 31))!;
    const minusOne = foldDecadeProjector.project(utcDateMs(-1))!;
    const minusTen = foldDecadeProjector.project(utcDateMs(-10))!;
    expect2({ row: zero.rowIndex, phase: zero.phase0, key: zero.rowKey }).toEqual({
      row: 0, phase: 0, key: "0s",
    });
    expect2(nine.rowIndex).toBe(0);
    expect2(nine.phase0).toBeGreaterThan(0.9);
    expect2(minusOne.rowIndex).toBe(-1);
    expect2(minusOne.rowKey).toBe("-10s");
    expect2(minusOne.phase0).toBe(0.9);
    expect2(minusTen.rowIndex).toBe(-1);
    expect2(minusTen.phase0).toBe(0);
  });

  test2("aligns the same wall date at the same phase within decimal slots", () => {
    const a = foldDecadeProjector.project(utcDateMs(1991, 6, 11))!;
    const b = foldDecadeProjector.project(utcDateMs(2001, 6, 11))!;
    expect2(a.phase0).toBeCloseTo(b.phase0, 14);

    const c = foldCenturyProjector.project(utcDateMs(1924, 1, 29,))!;
    const d = foldCenturyProjector.project(utcDateMs(2024, 1, 29))!;
    expect2(c.phase0).toBeCloseTo(d.phase0, 14);
  });

  test2("foldRowStartMs inverts decimal rows including negative rows", () => {
    for (const projector of [foldDecadeProjector, foldCenturyProjector, foldMillenniumProjector]) {
      for (const rowIndex of [-2, -1, 0, 1, 19]) {
        const start = foldRowStartMs(projector.id, rowIndex);
        const projected = projector.project(start)!;
        expect2(projected.rowIndex).toBe(rowIndex);
        expect2(projected.phase0).toBe(0);
        expect2(projector.project(start - 1)!.rowIndex).toBe(rowIndex - 1);
      }
    }
  });

  test2("rejects TimeClip edge rows or preserves a total inverse", () => {
    for (const projector of [foldDecadeProjector, foldCenturyProjector, foldMillenniumProjector]) {
      for (const t of [-8.64e15, 8.64e15, -8.64e15 + 1, 8.64e15 - 1]) {
        const projected = projector.project(t);
        if (!projected) continue;
        const start = foldRowStartMs(projector.id, projected.rowIndex);
        const end = foldRowStartMs(projector.id, projected.rowIndex + 1);
        expect2(Number.isFinite(new Date(start).getTime())).toBe(true);
        expect2(Number.isFinite(new Date(end).getTime())).toBe(true);
        expect2(projector.project(start)!.rowIndex).toBe(projected.rowIndex);
      }
    }
  });
});

describe2("adversarial probes (self-review of ba588b2)", () => {
  test2("week phase equals elapsed fraction for arbitrary instants (incl. pre-1970)", () => {
    let seed = 7;
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    for (let i = 0; i < 2000; i++) {
      const t = Math.floor((rnd() * 2 - 1) * 4e12);
      const p = foldWeekProjector.project(t)!;
      const frac = (t - foldRowStartMs("week", p.rowIndex)) / (7 * 86400000);
      expect2(Math.abs(p.phase0 - frac)).toBeLessThan(1e-9);
    }
    const p1969 = foldWeekProjector.project(Date.UTC(1969, 11, 29))!; // a pre-epoch Monday
    expect2(p1969.phase0).toBe(0);
    expect2(p1969.rowKey).toBe("1969-12-29");
  });

  test2("month rowStart inverts negative row indices (floor vs modulo)", () => {
    for (const idx of [0, -1, -13, 5]) {
      const start = foldRowStartMs("month", idx);
      const p = foldMonthProjector.project(start)!;
      expect2(p.rowIndex).toBe(idx);
      expect2(p.phase0).toBe(0);
      expect2(foldMonthProjector.project(start - 1)!.rowIndex).toBe(idx - 1);
    }
  });

  test2("nominal mid-row instant stays inside its row for every fold", () => {
    const projs = [foldYearProjector, foldMonthProjector, foldWeekProjector, foldDayProjector, foldHourProjector];
    let seed = 42;
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    for (const proj of projs) {
      for (let i = 0; i < 1000; i++) {
        const t = Math.floor(rnd() * 3e12);
        const row = proj.project(t)!.rowIndex;
        const mid = foldRowStartMs(proj.id, row) + FOLD_PERIOD_MS[proj.id]! / 2;
        expect2(proj.project(mid)!.rowIndex).toBe(row);
      }
    }
  });
});

describe2("Date TimeClip extremes (codex review of 6a92730)", () => {
  test2("projections at ±8.64e15 either reject or keep the inverse contract total", () => {
    const projs = [foldYearProjector, foldMonthProjector, foldWeekProjector, foldDayProjector, foldHourProjector];
    for (const proj of projs) {
      for (const t of [-8.64e15, 8.64e15, -8.64e15 + 1, 8.64e15 - 1]) {
        const p = proj.project(t);
        if (!p) continue; // edge rows may be rejected — that's the contract
        // accepted rows must have finite start/end, sane labels, stable inverse
        const start = foldRowStartMs(proj.id, p.rowIndex);
        const end = foldRowStartMs(proj.id, p.rowIndex + 1);
        expect2(Number.isFinite(start)).toBe(true);
        expect2(Number.isFinite(end)).toBe(true);
        expect2(p.rowKey.includes("NaN")).toBe(false);
        expect2(proj.project(start)!.rowIndex).toBe(p.rowIndex);
      }
    }
  });

  test2("ordinary modern instants are unaffected by the edge guards", () => {
    const t = Date.UTC(2026, 6, 11, 14, 30);
    for (const proj of [foldYearProjector, foldMonthProjector, foldWeekProjector, foldDayProjector, foldHourProjector]) {
      expect2(proj.project(t)).not.toBeNull();
    }
  });
});

describe2("precisionWindow", () => {
  test2("constructs exact half-open calendar cycles across leap and common February", () => {
    expect2(precisionWindow({
      tMs: Date.UTC(2024, 1, 29, 12),
      precision: { kind: "calendar", unit: "month" },
    })).toEqual([Date.UTC(2024, 1, 1), Date.UTC(2024, 2, 1)]);
    expect2(precisionWindow({
      tMs: Date.UTC(2023, 1, 28, 12),
      precision: { kind: "calendar", unit: "month" },
    })).toEqual([Date.UTC(2023, 1, 1), Date.UTC(2023, 2, 1)]);
  });

  test2("preserves years 0 through 99 and negative UTC years", () => {
    for (const year of [42, 0, -42]) {
      expect2(precisionWindow({
        tMs: utcDateMs(year, 6, 1),
        precision: { kind: "calendar", unit: "year" },
      })).toEqual([utcDateMs(year), utcDateMs(year + 1)]);
    }
  });

  test2("constructs day, hour, and minute windows containing the instant", () => {
    const tMs = Date.UTC(2026, 6, 11, 14, 37, 45, 123);
    expect2(precisionWindow({
      tMs,
      precision: { kind: "calendar", unit: "day" },
    })).toEqual([Date.UTC(2026, 6, 11), Date.UTC(2026, 6, 12)]);
    expect2(precisionWindow({
      tMs,
      precision: { kind: "calendar", unit: "hour" },
    })).toEqual([Date.UTC(2026, 6, 11, 14), Date.UTC(2026, 6, 11, 15)]);
    expect2(precisionWindow({
      tMs,
      precision: { kind: "calendar", unit: "minute" },
    })).toEqual([Date.UTC(2026, 6, 11, 14, 37), Date.UTC(2026, 6, 11, 14, 38)]);
  });

  test2("rejects uncertainty and missing or unrepresentable instants", () => {
    expect2(precisionWindow({
      tMs: Date.UTC(2026, 0, 1),
      precision: { kind: "uncertainty", beforeYears: 2, afterYears: 3 },
    })).toBeNull();
    expect2(precisionWindow({
      precision: { kind: "calendar", unit: "day" },
    })).toBeNull();
    expect2(precisionWindow({
      tMs: 8.64e15,
      precision: { kind: "calendar", unit: "year" },
    })).toBeNull();
  });
});

describe2("projectWindow", () => {
  test2("keeps a whole window in one row and preserves partial phases", () => {
    const start = Date.UTC(2026, 6, 11, 14, 15);
    const end = Date.UTC(2026, 6, 11, 14, 45);
    expect2(projectWindow("hour", start, end)).toEqual([{
      rowIndex: Math.floor(start / 3_600_000),
      phase0: 0.25,
      phase1: 0.75,
      full: false,
    }]);
  });

  test2("uses half-open row boundaries for an exact end at midnight", () => {
    const start = Date.UTC(2026, 6, 11);
    const end = Date.UTC(2026, 6, 12);
    expect2(projectWindow("day", start, end)).toEqual([{
      rowIndex: Math.floor(start / 86_400_000),
      phase0: 0,
      phase1: 1,
      full: true,
    }]);
  });

  test2("spans three or more rows with full middle fragments", () => {
    const start = Date.UTC(2026, 6, 11, 12);
    const end = Date.UTC(2026, 6, 14, 6);
    const fragments = projectWindow("day", start, end);
    expect2(fragments).toHaveLength(4);
    expect2(fragments.map(({ phase0, phase1, full }) => ({ phase0, phase1, full }))).toEqual([
      { phase0: 0.5, phase1: 1, full: false },
      { phase0: 0, phase1: 1, full: true },
      { phase0: 0, phase1: 1, full: true },
      { phase0: 0, phase1: 0.25, full: false },
    ]);
  });

  test2("maps common-February ghost space without filling it", () => {
    const fragments = projectWindow(
      "year",
      Date.UTC(2023, 1, 1),
      Date.UTC(2023, 2, 1),
    );
    expect2(fragments).toEqual([{
      rowIndex: 2023,
      phase0: 1 / 12,
      phase1: 2 / 12,
      full: false,
    }]);
  });

  test2("supports years 0 through 99, negative years, and exact year boundaries", () => {
    for (const year of [42, 0, -42]) {
      expect2(projectWindow("year", utcDateMs(year), utcDateMs(year + 1))).toEqual([{
        rowIndex: year,
        phase0: 0,
        phase1: 1,
        full: true,
      }]);
    }
  });

  test2("rejects invalid, empty, and TimeClip-edge windows", () => {
    expect2(projectWindow("day", Number.NaN, 0)).toEqual([]);
    expect2(projectWindow("day", 10, 10)).toEqual([]);
    expect2(projectWindow("year", 8.64e15 - 10, 8.64e15)).toEqual([]);
  });

  test2("conserves elapsed coverage for folds with linear phases", () => {
    const cases = [
      ["week", Date.UTC(2026, 6, 7, 6), Date.UTC(2026, 6, 24, 18)],
      ["day", Date.UTC(2026, 6, 7, 6), Date.UTC(2026, 6, 10, 18)],
      ["hour", Date.UTC(2026, 6, 7, 6, 15), Date.UTC(2026, 6, 7, 10, 45)],
    ] as const;
    for (const [foldId, start, end] of cases) {
      const fragments = projectWindow(foldId, start, end);
      const coveredMs = fragments.reduce((sum, fragment) => {
        const rowStart = foldRowStartMs(foldId, fragment.rowIndex);
        const rowEnd = foldRowStartMs(foldId, fragment.rowIndex + 1);
        return sum + (fragment.phase1 - fragment.phase0) * (rowEnd - rowStart);
      }, 0);
      expect2(coveredMs).toBeCloseTo(end - start, 5);
    }
  });
});
