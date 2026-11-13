/**
 * rgui gantt — calendar presets on top of the continuous scale (model.ts: toX/toT, zoomAt, panBy, fitView, ticks):
 * fixed day or week columns, as a roadmap page draws them (a CSS grid of days, a today column). Pure, no DOM.
 * Times are epoch seconds; `tzOffset` is seconds east of UTC (JST = 32400; localTzOffset() for the runtime's zone).
 */
import { MAX_SPP, MIN_SPP, toX, type GanttView } from "./model";

export type GanttPreset = "continuous" | "day" | "week";

/** the runtime's zone offset now, in seconds east of UTC */
export const localTzOffset = (at = Date.now()) => -new Date(at).getTimezoneOffset() * 60;

/** local midnight at or before t */
export const dayStart = (t: number, tzOffset = 32400) =>
  Math.floor((t + tzOffset) / 86400) * 86400 - tzOffset;

/** local Monday 00:00 at or before t */
export function weekStart(t: number, tzOffset = 32400) {
  const d = dayStart(t, tzOffset),
    dow = (new Date((d + tzOffset) * 1000).getUTCDay() + 6) % 7;
  return d - dow * 86400;
}

/** a view where each day (or week) is `colPx` wide and `from` (snapped to its day / week) sits at x = 0 */
export function presetView(
  preset: Exclude<GanttPreset, "continuous">,
  from: number,
  colPx = 40,
  tzOffset = 32400,
): GanttView {
  const unit = preset === "day" ? 86400 : 7 * 86400,
    t0 = preset === "day" ? dayStart(from, tzOffset) : weekStart(from, tzOffset);
  return { t0, spp: Math.min(MAX_SPP, Math.max(MIN_SPP, unit / colPx)) };
}

export type GanttColumn = {
  /** column start (local midnight / Monday) */
  t: number;
  x: number;
  w: number;
  /** "YYYY-MM-DD" of the column start, in the zone */
  date: string;
  /** today falls in this column */
  today: boolean;
  /** Saturday or Sunday (day columns) */
  weekend: boolean;
};

/** the day or week columns over [x0, x1] px of a view (at most 2000) */
export function columns(
  v: GanttView,
  x0: number,
  x1: number,
  preset: Exclude<GanttPreset, "continuous"> = "day",
  now = Date.now() / 1000,
  tzOffset = 32400,
): GanttColumn[] {
  const unit = preset === "day" ? 86400 : 7 * 86400,
    snap = preset === "day" ? dayStart : weekStart,
    out: GanttColumn[] = [];
  for (let t = snap(v.t0 + x0 * v.spp, tzOffset); toX(v, t) <= x1 && out.length < 2000; t += unit) {
    const d = new Date((t + tzOffset) * 1000),
      dow = d.getUTCDay();
    out.push({
      t,
      x: toX(v, t),
      w: unit / v.spp,
      date: d.toISOString().slice(0, 10),
      today: now >= t && now < t + unit,
      weekend: preset === "day" && (dow === 0 || dow === 6),
    });
  }
  return out;
}

/** "YYYY-MM-DD" (local midnight in the zone) → epoch seconds; undefined for anything else */
export function parseDay(s: string, tzOffset = 32400): number | undefined {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return undefined;
  return Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!) / 1000 - tzOffset;
}
