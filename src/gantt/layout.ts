/**
 * rgui gantt — row layout helpers for views whose row set changes while you look (pure, no DOM):
 *
 * - stableSlots(): an `arrange` hook for GanttController. When the shown rows change, rows that stay keep their
 *   exact slot; rows that leave free their slot (a `{ blank: true }` line); incoming rows take the top-most free
 *   slot of their own group (a header only a header slot); the rest are appended below, under a repeated group
 *   header when the group above is another one. Linear in the row count.
 * - timeWindow() / windowStale() / inWindow(): the in-view filter (only tasks whose bars overlap the view ± a
 *   margin), re-picked only on zoom or when the view leaves the span it was picked for, so a sideways pan does
 *   not rebuild the rows.
 * - nearestOutside(): the next tasks outside a window, nearest in time first (infinite scroll down).
 * - rowShift(): per-row y offsets between two layouts (FLIP animation through controller.dy).
 */
import { endOf, startOf, type GanttBar } from "./model";
import type { GanttLine } from "./core";

/** a row's identity across layouts: "<lane> <id>" for a task, "lane <lane>" for a header, null for a blank */
export const lineKey = (l: GanttLine): string | null =>
  l.blank ? null : (l.key ?? (l.bar ? `${l.bar.lane} ${l.bar.id}` : `lane ${l.lane}`));
const laneOf = (l: GanttLine) => (l.bar ? l.bar.lane : l.lane);

type Slot = { key: string | null; lane?: string; hdr: boolean; line: GanttLine | null };

export type StableSlots = {
  /** pass as controller.arrange */
  arrange: (lines: GanttLine[]) => GanttLine[];
  /** lay the next rows out afresh (a "fit" or "today" button, a filter switched off) */
  reset(): void;
  /** drop free slots at the bottom on the next arrange (after a quiet while) */
  trim(): void;
  /** current slot keys (tests, debugging) */
  keys(): (string | null)[];
};

/** an arrange hook keeping rows in stable slots; `enabled()` false = pass the lines through and forget the slots */
export function stableSlots(enabled: () => boolean = () => true): StableSlots {
  let slots: Slot[] | null = null,
    trimNext = false;
  const arrange = (lines: GanttLine[]): GanttLine[] => {
    if (!enabled() || !slots) {
      slots = lines.map((l) => ({ key: lineKey(l), lane: laneOf(l), hdr: !l.bar, line: l }));
      trimNext = false;
      return lines;
    }
    const by = new Map(lines.map((l) => [lineKey(l), l]));
    const next: Slot[] = slots.map((s) =>
      by.has(s.key) || (s.key && s.line?.key)
        ? { ...s, line: by.get(s.key) ?? s.line }
        : { ...s, key: null, line: null },
    );
    const placed = new Set(next.map((s) => s.key));
    // free slots per group and kind, top-most first (a queue each, so thousands of rows stay linear)
    const free = new Map<string, number[]>();
    next.forEach((s, i) => {
      if (s.key !== null) return;
      const fk = `${s.hdr ? 1 : 0}${s.lane}`;
      const q = free.get(fk);
      if (q) q.push(i);
      else free.set(fk, [i]);
    });
    let tail = next.length;
    while (tail > 0 && next[tail - 1]!.key === null) tail--;
    for (const l of lines) {
      const k = lineKey(l);
      if (placed.has(k)) continue;
      const lane = laneOf(l),
        hdr = !l.bar,
        q = free.get(`${hdr ? 1 : 0}${lane}`);
      while (q?.length && q[0]! >= tail) q.shift(); // slots after the tail are overwritten by appends
      if (q?.length) {
        next[q.shift()!] = { key: k, lane, hdr, line: l };
        continue;
      }
      if (!hdr && (tail === 0 || next[tail - 1]!.lane !== lane)) {
        const h: GanttLine = { lane, segs: [], key: `lane ${lane}\u0001${tail}` };
        next[tail++] = { key: h.key!, lane, hdr: true, line: h };
      }
      next[tail++] = { key: k, lane, hdr, line: l };
    }
    next.length = Math.max(tail, next.length);
    // a repeated group header whose rows have all gone is a free slot too
    for (let i = 0; i < next.length; i++) {
      if (!next[i]!.line?.key) continue;
      let j = i + 1;
      while (j < next.length && next[j]!.key === null) j++;
      if (!(j < next.length && next[j]!.lane === next[i]!.lane && !next[j]!.hdr))
        next[i] = { ...next[i]!, key: null, line: null };
    }
    if (trimNext) while (next.length && next[next.length - 1]!.key === null) next.pop();
    trimNext = false;
    slots = next;
    return next.map((s) => s.line ?? { segs: [], blank: true });
  };
  return {
    arrange,
    reset: () => {
      slots = null;
    },
    trim: () => {
      trimNext = true;
    },
    keys: () => (slots ?? []).map((s) => s.key),
  };
}

/** the span an in-view filter picks rows for: the view widened by `margin` view widths each side */
export type GanttWindow = { from: number; to: number; span: number };

export function timeWindow(view: { from: number; to: number }, margin = 1): GanttWindow {
  const span = view.to - view.from;
  return { from: view.from - margin * span, to: view.to + margin * span, span };
}

/** pick rows again? only when the view left the window or zoomed by more than `zoomTol` (default 20 %) */
export function windowStale(
  w: GanttWindow | null | undefined,
  view: { from: number; to: number },
  zoomTol = 0.2,
) {
  if (!w) return true;
  const span = view.to - view.from;
  return view.from < w.from || view.to > w.to || Math.abs(span - w.span) > w.span * zoomTol;
}

/** bars overlapping [from, to] (undated ones never), plus any whose "<lane> <id>" is in `keep` (the focused task) */
export function inWindow<T extends GanttBar & { undated?: boolean }>(
  bars: T[],
  w: { from: number; to: number },
  now: number,
  keep?: Set<string> | string,
): T[] {
  const k = typeof keep === "string" ? new Set([keep]) : keep;
  return bars.filter(
    (b) =>
      k?.has(`${b.lane} ${b.id}`) || (!b.undated && startOf(b) <= w.to && endOf(b, now) >= w.from),
  );
}

/** the bars not in `shown`, nearest in time to `mid` first (undated last out), at most n */
export function nearestOutside<T extends GanttBar & { undated?: boolean }>(
  bars: T[],
  shown: Iterable<T>,
  mid: number,
  now: number,
  n = Infinity,
): T[] {
  const s = new Set(shown),
    dist = (b: T) => Math.max(0, startOf(b) - mid, mid - endOf(b, now));
  return bars
    .filter((b) => !b.undated && !s.has(b))
    .sort((a, b) => dist(a) - dist(b))
    .slice(0, n);
}

/**
 * FLIP offsets: for each new row, old top − new top (px) when the row was there before, `enter` for a new row,
 * 0 for blanks. Animate with `ctl.dy = (i) => off[i] * (1 - ease(t))`.
 */
export function rowShift(
  before: Map<string | null, number>,
  after: GanttLine[],
  top: (i: number) => number,
  enter = 0,
): number[] {
  return after.map((l, i) => {
    const k = lineKey(l);
    if (k === null) return 0;
    const y = before.get(k);
    return y === undefined ? enter : y - top(i);
  });
}

/** the tops of the rows now, by lineKey (take before setBars, pass to rowShift after) */
export const rowTops = (lines: GanttLine[], top: (i: number) => number) =>
  new Map(lines.map((l, i) => [lineKey(l), top(i)]));
