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
