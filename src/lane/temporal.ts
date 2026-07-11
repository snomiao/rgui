/**
 * Pure UTC calendar projections for the lane timeline.
 *
 * The year fold gives every month equal screen width, then divides that cell
 * by the month's maximum Gregorian day count. This aligns wall dates across
 * years and leaves an implicit Feb 29 ghost gap in common years. The accepted
 * trade-off is that one day is slightly wider in February than in January.
 */
export type FoldProjection = {
  rowKey: string;
  rowIndex: number;
  rowLabel: string;
  phase0: number;
  phase1: number;
  ghost?: boolean;
};

export interface TemporalProjector {
  readonly id: string;
  project(tMs: number): FoldProjection | null;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const MONTH_DAY_SLOTS = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const;

/**
 * Return an event's exact timestamp after applying ECMAScript Date's TimeClip.
 * Approximate `y` coordinates deliberately have no fallback here: calendar
 * folds must not invent a month or day from a years-before-present value.
 */
export function evTimestampMs(event: unknown): number | null {
  if (event === null || typeof event !== "object") return null;
  const value = (event as { readonly tMs?: unknown }).tMs;
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const clipped = new Date(value).getTime();
  return Number.isFinite(clipped) ? clipped : null;
}

function projectFoldYear(tMs: number): FoldProjection | null {
  if (!Number.isFinite(tMs)) return null;
  const instant = new Date(tMs);
  const clippedMs = instant.getTime();
  if (!Number.isFinite(clippedMs)) return null;

  const year = instant.getUTCFullYear();
  const month = instant.getUTCMonth();
  const dayIndex = instant.getUTCDate() - 1;
  const millisInDay =
    (((instant.getUTCHours() * 60 + instant.getUTCMinutes()) * 60 +
      instant.getUTCSeconds()) * 1000) +
    instant.getUTCMilliseconds();
  const monthPhase =
    (dayIndex + millisInDay / MS_PER_DAY) / MONTH_DAY_SLOTS[month]!;
  const phase = (month + monthPhase) / 12;
  // Defensive invariant guard; valid Date components make this unreachable.
  if (!(phase >= 0 && phase < 1)) return null;

  if (!rowRepresentable("year", year)) return null;
  const rowKey = String(year);
  return {
    rowKey,
    rowIndex: year,
    rowLabel: rowKey,
    phase0: phase,
    phase1: phase,
  };
}

/**
 * UTC year fold with twelve equal-width month cells. Each cell uses the
 * month's maximum Gregorian day count, keeping wall dates aligned across
 * years and leaving a ghost Feb 29 slot in common years.
 */
export const foldYearProjector: TemporalProjector = {
  id: "year",
  project: projectFoldYear,
};

// ── finer folds — same contract, same max-slot equal-width principle ────────
// rowIndex is always a context-free integer (stable across ingest); phase
// slots use the period's MAXIMUM sub-unit count so identical wall times align
// across rows (short months leave ghost day slots, like Feb 29 above).

const pad2 = (n: number) => String(n).padStart(2, "0");

/** a row is representable only if its start AND end are valid Dates —
 * partial rows at the TimeClip extremes are rejected so foldRowStartMs,
 * row labels, and mid-row instants stay total over accepted projections */
function rowRepresentable(foldId: string, rowIndex: number): boolean {
  return (
    Number.isFinite(foldRowStartMs(foldId, rowIndex)) &&
    Number.isFinite(foldRowStartMs(foldId, rowIndex + 1))
  );
}

function clipped(tMs: number): Date | null {
  if (!Number.isFinite(tMs)) return null;
  const d = new Date(tMs);
  return Number.isFinite(d.getTime()) ? d : null;
}

/** month fold: one row per calendar month, 31 max-day slots */
export const foldMonthProjector: TemporalProjector = {
  id: "month",
  project(tMs) {
    const d = clipped(tMs);
    if (!d) return null;
    const year = d.getUTCFullYear();
    const month = d.getUTCMonth();
    const phase = (d.getUTCDate() - 1 + fracOfDayUTC(d)) / 31;
    if (!(phase >= 0 && phase < 1)) return null;
    const rowIndex = year * 12 + month;
    if (!rowRepresentable("month", rowIndex)) return null;
    const rowKey = `${year}-${pad2(month + 1)}`;
    return { rowKey, rowIndex, rowLabel: rowKey, phase0: phase, phase1: phase };
  },
};

const EPOCH_MONDAY_MS = Date.UTC(1970, 0, 5); // first Monday after the epoch
const WEEK_MS = 7 * 24 * 3600 * 1000;
const DAY_MS = 24 * 3600 * 1000;
const HOUR_MS = 3600 * 1000;

/** week fold: one row per Monday-start UTC week, 7 weekday slots.
 *  Rows are keyed by their Monday's date (avoids ISO week-year edge cases). */
export const foldWeekProjector: TemporalProjector = {
  id: "week",
  project(tMs) {
    const d = clipped(tMs);
    if (!d) return null;
    const t = d.getTime();
    const rowIndex = Math.floor((t - EPOCH_MONDAY_MS) / WEEK_MS);
    const weekday = (d.getUTCDay() + 6) % 7; // Mon=0 … Sun=6
    const phase = (weekday + fracOfDayUTC(d)) / 7;
    if (!(phase >= 0 && phase < 1)) return null;
    if (!rowRepresentable("week", rowIndex)) return null;
    const mon = new Date(EPOCH_MONDAY_MS + rowIndex * WEEK_MS);
    const rowKey = `${mon.getUTCFullYear()}-${pad2(mon.getUTCMonth() + 1)}-${pad2(mon.getUTCDate())}`;
    return { rowKey, rowIndex, rowLabel: rowKey, phase0: phase, phase1: phase };
  },
};

/** day fold: one row per UTC date, 24 hour slots */
export const foldDayProjector: TemporalProjector = {
  id: "day",
  project(tMs) {
    const d = clipped(tMs);
    if (!d) return null;
    const rowIndex = Math.floor(d.getTime() / DAY_MS);
    const phase = fracOfDayUTC(d);
    if (!(phase >= 0 && phase < 1)) return null;
    if (!rowRepresentable("day", rowIndex)) return null;
    const rowKey = `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
    return { rowKey, rowIndex, rowLabel: rowKey, phase0: phase, phase1: phase };
  },
};

/** hour fold: one row per UTC hour, 60 minute slots */
export const foldHourProjector: TemporalProjector = {
  id: "hour",
  project(tMs) {
    const d = clipped(tMs);
    if (!d) return null;
    const rowIndex = Math.floor(d.getTime() / HOUR_MS);
    const phase =
      (d.getUTCMinutes() + (d.getUTCSeconds() * 1000 + d.getUTCMilliseconds()) / 60000) / 60;
    if (!(phase >= 0 && phase < 1)) return null;
    if (!rowRepresentable("hour", rowIndex)) return null;
    const rowKey = `${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())} ${pad2(d.getUTCHours())}:00`;
    return { rowKey, rowIndex, rowLabel: rowKey, phase0: phase, phase1: phase };
  },
};

function fracOfDayUTC(d: Date): number {
  return (
    (((d.getUTCHours() * 60 + d.getUTCMinutes()) * 60 + d.getUTCSeconds()) * 1000 +
      d.getUTCMilliseconds()) /
    DAY_MS
  );
}

/** the start instant of a fold row — inverse of project()'s rowIndex */
export function foldRowStartMs(foldId: string, rowIndex: number): number {
  switch (foldId) {
    case "year": {
      // Date.UTC remaps years 0..99 to 1900..1999; setUTCFullYear does not
      const d = new Date(0);
      d.setUTCFullYear(rowIndex, 0, 1);
      d.setUTCHours(0, 0, 0, 0);
      return d.getTime();
    }
    case "month": {
      const d = new Date(0);
      d.setUTCFullYear(Math.floor(rowIndex / 12), ((rowIndex % 12) + 12) % 12, 1);
      d.setUTCHours(0, 0, 0, 0);
      return d.getTime();
    }
    case "week":
      return EPOCH_MONDAY_MS + rowIndex * WEEK_MS;
    case "day":
      return rowIndex * DAY_MS;
    case "hour":
      return rowIndex * HOUR_MS;
    default:
      return NaN;
  }
}

/** nominal period length of a fold row (ms) — for scale-continuous mapping */
export const FOLD_PERIOD_MS: Record<string, number> = {
  year: 365.2425 * DAY_MS,
  month: (365.2425 / 12) * DAY_MS,
  week: WEEK_MS,
  day: DAY_MS,
  hour: HOUR_MS,
};
