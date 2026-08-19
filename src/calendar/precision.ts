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

/**
 * ± uncertainty in YEARS for the continuous (unfolded) axis, which draws a soft
 * gradient band of this half-width around the event.
 *
 * The fold view withholds false precision through the precision window; the
 * continuous axis does it through this number. A month-precision event given
 * the default minute-wide span draws a hairline at the month's first instant —
 * the same misplacement the fold view had, in the view that has no columns to
 * make it obvious.
 *
 * Only the month case is derived here. Widening the default for ordinary
 * all-day events would be defensible on the same argument, but it would move
 * every existing calendar's rendering, and nothing has asked it to.
 */
export function spanYears(
  e: Pick<IcsEvent, "allDay" | "precision">,
  defaultSpanYears: number,
): number {
  // half of an average month; the band is a statement about resolution, not a
  // claim that this particular month has 30.44 days
  if (e.precision === "month") return (30.44 / 2) / 365.25;
  return defaultSpanYears;
}
