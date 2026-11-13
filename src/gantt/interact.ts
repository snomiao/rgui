/**
 * rgui gantt — interaction intents as pure functions (no DOM): which part of a bar a point hits, and
 * drag-to-propose: dragging a bar never moves the task, it proposes a desired slot (a "shadow") that the
 * host sends to whoever owns the task. A desire is answered (dropped) once the task is re-planned.
 *
 *   const h = ctl.hitTest(x, y);                       // pointerdown
 *   let d = h && startDrag(h, ctl.desires[key]);       // null when the bar cannot be proposed (closed, undated)
 *   d = dragTo(d, dx, ctl);                            // pointermove: d.a / d.b follow the pointer (linear or log)
 *   if (d.moved) ctl.setDesires({ ...ctl.desires, [key]: toDesire(d) });   // pointerup
 */
import { endOf, startOf, type GanttBar } from "./model";
import type { GanttLine, GanttRow } from "./core";

/** which part of a bar a point is on */
export type GanttHitPart = "start" | "end" | "body" | "none";

export type GanttHit = {
  /** row index among the shown lines */
  index: number;
  line: GanttLine;
  bar?: GanttRow;
  /** the time under the point */
  t: number;
  /** the bar's drawn extent in viewport px */
  x0?: number;
  x1?: number;
  part: GanttHitPart;
};

/** a desired slot for a task: a..b (epoch s), and the plan it was made against (pa = start, pdue = due) */
export type GanttDesire = { a: number; b: number; pa: number; pdue: number };

/** point x against a bar drawn over [x0, x1]: an edge within `edge` px (bars wider than 16 px), the body, or none */
export function hitPart(x: number, x0: number, x1: number, edge = 6): GanttHitPart {
  if (x < x0 - edge || x > x1 + edge) return "none";
  const wide = x1 - x0 > 16;
  return wide && x > x1 - edge ? "end" : wide && x < x0 + edge ? "start" : "body";
}

/** the task was re-planned (start or due moved) since the desire was made: the desire is answered */
export const desireAnswered = (d: GanttDesire, b: GanttBar) =>
  d.pa !== startOf(b) || d.pdue !== b.due;

/** a drag in progress */
export type GanttDrag = {
  key: string;
  bar: GanttRow;
  part: Exclude<GanttHitPart, "none">;
  /** the plan now: start, end, due */
  pa: number;
  pb: number;
  pdue: number;
  /** the slot when the drag began (an earlier desire, or the plan) and now */
  a0: number;
  b0: number;
  a: number;
  b: number;
  moved: boolean;
};

/** begin a drag-to-propose on a hit; undefined when the bar cannot be proposed (no bar, closed, undated, off it) */
export function startDrag(
  h: GanttHit,
  prev?: GanttDesire,
  now = Date.now() / 1000,
): GanttDrag | undefined {
  const bar = h.bar;
  if (!bar || bar.undated || bar.outcome || bar.b !== undefined || h.part === "none")
    return undefined;
  const pa = startOf(bar),
    pb = endOf(bar, now),
    a0 = prev?.a ?? pa,
    b0 = prev?.b ?? pb;
  return {
    key: `${bar.lane} ${bar.id}`,
    bar,
    part: h.part,
    pa,
    pb,
    pdue: bar.due,
    a0,
    b0,
    a: a0,
    b: b0,
    moved: false,
  };
}

/**
 * the drag moved dx px from where it began: body = move both ends, an edge = that end (at least `minSpan` s
 * long). The mapping goes through the scale (cx/ct), so it is right on a log axis too. Moves under `slop` px
 * do not count (a click).
 */
export function dragTo(
  d: GanttDrag,
  dx: number,
  scale: { cx(t: number): number; ct(x: number): number },
  minSpan = 60,
  slop = 3,
): GanttDrag {
  if (!d.moved && Math.abs(dx) < slop) return d;
  const at = (t: number) => scale.ct(scale.cx(t) + dx),
    out = { ...d, moved: true };
  if (d.part === "body") {
    const s = at(d.a0) - d.a0;
    out.a = d.a0 + s;
    out.b = d.b0 + s;
  } else if (d.part === "start") out.a = Math.min(at(d.a0), d.b - minSpan);
  else out.b = Math.max(at(d.b0), d.a + minSpan);
  return out;
}

/** the desire a finished drag proposes (whole seconds) */
export const toDesire = (d: GanttDrag): GanttDesire => ({
  a: Math.round(d.a),
  b: Math.round(d.b),
  pa: d.pa,
  pdue: d.pdue,
});

/** the cursor a hit wants: grab on a body, ew-resize on an edge */
export const cursorOf = (p: GanttHitPart | undefined) =>
  p === "body" ? "grab" : p === "start" || p === "end" ? "ew-resize" : "";
