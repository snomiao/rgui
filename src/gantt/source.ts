/**
 * rgui gantt — data adapter: feed the chart from any task source.
 *
 *   const bars = toBars(myTasks, (t) => ({ id: t.id, name: t.title, group: t.category, start: t.start,
 *     end: t.end, status: t.status }), { statuses: MY_STATUSES });
 *   chart.setBars(bars)  // with new GanttChart(el, { statuses: MY_STATUSES })
 *
 * Items without dates are listed (a row, no bar). group becomes the header row. status picks the colour and the
 * badge label from the status map; closed statuses end the bar. milestone draws a diamond at end; deps draw an arrow
 * from each dependency's end to this item's start.
 */
import type { GanttBar } from "./model";

/** one status: bar/badge colour, people-facing label, and whether the item is finished (its bar ends at end) */
/** one status: bar/badge colour, people-facing label, a mark that does not rely on colour (✓ ▶ ■ ○), and whether
 * the item is finished (its bar ends at end) */
export type GanttStatus = { color: string; label: string; mark?: string; closed?: boolean; badge?: boolean };
export type GanttStatuses = Record<string, GanttStatus>;

/** what a task source maps each of its items to */
export type GanttItem = {
  id: string;
  name: string;
  /** header row the item sits under (a category, a team, a lane) */
  group?: string;
  /** dates: ISO string, Date, or epoch milliseconds; both optional (undated items get a row without a bar) */
  start?: string | number | Date;
  end?: string | number | Date;
  status?: string;
  /** shown in the tooltip and the page's dialog */
  detail?: string;
  milestone?: boolean;
  /** ids this item waits for */
  deps?: string[];
  /** 0..1 */
  progress?: number;
};

/** the chart's bar plus the adapter's fields */
export type GanttSourceBar = GanttBar & {
  what?: string;
  status?: string;
  undated?: boolean;
  milestone?: boolean;
  deps?: string[];
};

const sec = (v: string | number | Date | undefined): number | undefined => {
  if (v === undefined || v === "") return undefined;
  const ms = v instanceof Date ? v.getTime() : typeof v === "number" ? v : Date.parse(v);
  return Number.isFinite(ms) ? ms / 1000 : undefined;
};

/**
 * map any items to chart bars. A start without an end is a one-day bar; an end without a start is a milestone-
 * like point. Undated items sit at now with `undated` set (the chart draws no bar for them).
 */
export function toBars<T>(
  items: T[],
  map: (item: T) => GanttItem,
  opts: { statuses?: GanttStatuses; now?: number; defaultGroup?: string } = {},
): GanttSourceBar[] {
  const now = opts.now ?? Date.now() / 1000;
  return items.map((it) => {
    const g = map(it),
      st = g.status ? opts.statuses?.[g.status] : undefined;
    let a = sec(g.start),
      due = sec(g.end);
    const undated = a === undefined && due === undefined;
    if (a === undefined) a = due ?? now;
    if (due === undefined) due = undated ? now : a + 86400;
    const bar: GanttSourceBar = {
      id: g.id,
      name: g.name,
      lane: g.group ?? opts.defaultGroup ?? "",
      a,
      due: Math.max(a, due),
      ...(st?.closed ? { b: Math.max(a, due), outcome: "verified" } : {}),
      ...(g.status ? { status: g.status } : {}),
      ...(g.detail ? { what: g.detail } : {}),
      ...(g.milestone ? { milestone: true } : {}),
      ...(g.deps?.length ? { deps: g.deps } : {}),
      ...(g.progress !== undefined ? { progress: g.progress } : {}),
      ...(undated ? { undated: true, stale: true } : {}),
    };
    return bar;
  });
}
