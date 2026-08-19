/**
 * How an .ics event's declared precision becomes render-time precision.
 *
 * Pure, and separate from `calendar-main.ts` on purpose: that module touches
 * the DOM at import time, so the one decision worth pinning down could not be
 * tested where it was written. The decision is small and easy to reverse by
 * accident — a later edit that treats a month-precision event like any other
 * all-day event produces a plausible-looking month-long ribbon and no error.
 */
import type { IcsEvent } from "./ics.js";

/** What the lane's `Ev.precision` should be for this event. */
export type CalendarUnit = "year" | "month" | "day" | "hour" | "minute";

export function precisionUnit(e: Pick<IcsEvent, "allDay" | "precision">): CalendarUnit {
  if (e.precision === "month") return "month";
  return e.allDay ? "day" : "minute";
}

/**
 * Real extent in ms, or undefined when the event has none to assert.
 *
 * A month-precision event is encoded as a whole-month span because the feed
 * needs dates, not because anything lasts a month. Reporting that span as a
 * duration would turn "sometime in March" into "all of March".
 */
export function durationMs(
  e: Pick<IcsEvent, "allDay" | "precision">,
  spanMs: number,
): number | undefined {
  if (e.precision === "month") return undefined;
  // A single-day all-day event already renders as its own day-band; a duration
  // block on top of that would just redraw the band.
  if (e.allDay && spanMs <= 86400_000) return undefined;
  return spanMs;
}
