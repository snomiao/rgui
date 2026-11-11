/**
 * rgui gantt — pure model: bar states, the drawn segments of a bar, the
 * time ⇄ pixel view and readable time ticks. No DOM here (unit-tested).
 *
 * Times are epoch SECONDS (st-eta's unit).
 */

export type GanttKind = "compute" | "ci" | "human" | "lane";

/** one task row; the shape st-eta's `bars()` produces, plus a display name */
export type GanttBar = {
  id: string;
  /** short name shown at the left edge (falls back to id) */
  name?: string;
  /** group (st-eta: the lane) */
  lane: string;
  /** start (planned: the latest start) */
  a: number;
  /** promised end / ETA (planned: the latest end = all high estimates) */
  due: number;
  /** actual end, when closed */
  b?: number;
  outcome?: string;
  planned?: boolean;
  kind?: GanttKind;
  /** planned: end when every step hits its low estimate */
  lo?: number;
  /** planned: earliest start (all low estimates) */
  loA?: number;
  stale?: boolean;
  /** on the critical path */
  crit?: boolean;
  /** the first plan (start / promised end), drawn as a faint ghost bar when it differs */
  a0?: number;
  due0?: number;
  /** last time the estimate was confirmed or touched */
  confirmed?: number;
  /** waiting (paused / blocked) since t: drawn hollow and hatched, never "late" */
  wait?: { t: number; why?: string; on?: string };
  /** 0..1 progress, drawn as an underline coloured ahead / on track / behind */
  progress?: number;
  /** estimate events: m = moved (long tick), c = confirmed (short), s = state change (dashed);
   * events of one batch reschedule share a change id and t, so their ticks line up */
  ticks?: GanttTick[];
};

export type GanttTick = { t: number; k: "m" | "c" | "s"; change?: string };

export type GanttState =
  | "verified"
  | "unverified"
  | "open"
  | "late"
  | "stale"
  | "planned"
  | "human"
  | "lane"
  | "cancel";

export const GANTT_COLORS: Record<GanttState, string> = {
  verified: "#2e7d32",
  unverified: "#9e9d24",
  open: "#1565c0",
  late: "#c62828",
  stale: "#9e9e9e",
  planned: "#5c6bc0",
  human: "#ef6c00",
  lane: "#6a1b9a",
  cancel: "#bdbdbd",
};

export function stateOf(b: GanttBar): GanttState {
  if (b.planned) return b.kind === "human" || b.kind === "lane" ? b.kind : "planned";
  if (b.outcome === "cancel") return "cancel";
  if (b.outcome === "verified") return "verified";
  if (b.b !== undefined) return "unverified";
  return b.stale ? "stale" : "open";
}

/** where the bar ends now: closed → b; planned/stale → due; open → max(due, now) */
export function endOf(b: GanttBar, now: number): number {
  return b.b ?? (b.planned || b.stale ? b.due : Math.max(b.due, now));
}

/** a drawn piece of a bar: "range" = the light low–high band, "core" = solid, "late" = past the ETA */
export type GanttSegment = {
  from: number;
  to: number;
  part: "range" | "core" | "late";
  state: GanttState;
};

export function segmentsOf(b: GanttBar, now: number): GanttSegment[] {
  const st = stateOf(b),
    end = endOf(b, now),
    out: GanttSegment[] = [];
  if (b.planned && b.loA !== undefined && b.lo !== undefined) {
    out.push({ from: b.loA, to: end, part: "range", state: st });
    if (b.lo > b.a) out.push({ from: b.a, to: b.lo, part: "core", state: st });
    return out;
  }
  const okEnd = b.planned || b.stale ? end : Math.min(end, b.due);
  out.push({ from: b.a, to: okEnd, part: "core", state: st });
  if (!b.planned && !b.stale && end > b.due)
    out.push({ from: b.due, to: end, part: "late", state: "late" });
  return out;
}

/** earliest drawn time of a bar */
export const startOf = (b: GanttBar) => (b.planned && b.loA !== undefined ? b.loA : b.a);

/** the horizontal view: t0 = time at x=0, spp = seconds per CSS pixel */
export type GanttView = { t0: number; spp: number };

export const MIN_SPP = 0.5; // ~2 px a second
export const MAX_SPP = 86400 * 30; // a month a pixel

export const toX = (v: GanttView, t: number) => (t - v.t0) / v.spp;
export const toT = (v: GanttView, x: number) => v.t0 + x * v.spp;

/** zoom by factor k (>1 = zoom in) keeping the time under pixel x fixed */
export function zoomAt(v: GanttView, x: number, k: number): GanttView {
  const spp = Math.min(MAX_SPP, Math.max(MIN_SPP, v.spp / k)),
    t = toT(v, x);
  return { t0: t - x * spp, spp };
}

/** pan by dx pixels (positive = content moves left = later times) */
export const panBy = (v: GanttView, dx: number): GanttView => ({
  t0: v.t0 + dx * v.spp,
  spp: v.spp,
});

/** a view showing [lo, hi] in width px with a margin of pad px each side */
export function fitView(lo: number, hi: number, width: number, pad = 24): GanttView {
  const w = Math.max(1, width - 2 * pad),
    spp = Math.min(MAX_SPP, Math.max(MIN_SPP, (hi - lo || 3600) / w));
  return { t0: lo - pad * spp, spp };
}

const STEPS = [
  60, 300, 600, 900, 1800, 3600, 7200, 10800, 21600, 43200, 86400, 172800, 604800, 2592000,
];

/** the smallest readable step putting ticks at least minPx apart */
export function tickStep(spp: number, minPx = 80): number {
  return STEPS.find((s) => s / spp >= minPx) ?? STEPS[STEPS.length - 1]!;
}

/**
 * tick times in [from, to], aligned to the step in a zone given as an offset
 * in seconds east of UTC (JST = 32400), so "00:00" is local midnight
 */
export function ticks(from: number, to: number, step: number, tzOffset = 32400): number[] {
  const out: number[] = [];
  const first = Math.ceil((from + tzOffset) / step) * step - tzOffset;
  for (let t = first; t <= to && out.length < 1000; t += step) out.push(t);
  return out;
}

/** "HH:MM", or "MM-DD" on a local midnight (when the step is a day or more, always the date) */
export function tickLabel(t: number, step: number, tzOffset = 32400): string {
  const d = new Date((t + tzOffset) * 1000),
    p = (n: number) => String(n).padStart(2, "0"),
    hm = `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`,
    md = `${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
  if (step >= 86400) return md;
  return hm === "00:00" ? md : hm;
}

/** rows grouped by lane in first-seen order: [{ lane, bars }] */
export function groupRows(bars: GanttBar[]): { lane: string; bars: GanttBar[] }[] {
  const m = new Map<string, GanttBar[]>();
  for (const b of bars) m.set(b.lane, [...(m.get(b.lane) ?? []), b]);
  return [...m].map(([lane, bs]) => ({ lane, bars: bs }));
}

/** language-free duration, minutes and up: "5M", "1.5H", "3D", "2W", "4Mo", "1.1Y" */
export function dur(sec: number): string {
  const a = Math.abs(sec),
    u: [number, string][] = [
      [365 * 86400, "Y"],
      [30 * 86400, "Mo"],
      [7 * 86400, "W"],
      [86400, "D"],
      [3600, "H"],
      [60, "M"],
    ];
  for (const [s, n] of u)
    if (a >= s || n === "M") {
      const v = a / s;
      return `${sec < 0 ? "-" : ""}${v >= 10 || n === "M" ? Math.round(v) : +v.toFixed(1)}${n}`;
    }
  return "";
}

export type GanttPace = "ahead" | "on" | "behind";
export const PACE_COLORS: Record<GanttPace, string> = {
  ahead: "#2e7d32",
  on: "#1565c0",
  behind: "#ef6c00",
};

/** where the progress underline ends against now: behind (left of now), ahead (right) or on track */
export function paceOf(b: GanttBar, now: number): GanttPace | undefined {
  if (b.progress === undefined || b.b !== undefined) return undefined;
  const span = Math.max(60, b.due - b.a),
    tip = b.a + b.progress * span,
    near = Math.max(300, span * 0.05);
  return tip < now - near ? "behind" : tip > now + near ? "ahead" : "on";
}

/** the category of a task: the first two path segments, /<lane>/<category>, when the id is deeper than that */
export function categoryOf(id: string): string | undefined {
  const p = id.split("/");
  return p.length > 3 && p[0] === "" ? `/${p[1]}/${p[2]}` : undefined;
}

/** a task someone is on now: started (open), overdue or blocked; planned, closed and stale ones are not */
export const isActive = (b: GanttBar) => !b.planned && !b.stale && b.b === undefined;

/**
 * group each lane's rows by category: the category row first (synthesized when the category has no bar of its
 * own and at least two members: its span covers the members, open while any member is open), then its members in their order
 */
export function categorize<T extends GanttBar>(bars: T[], known?: Set<string>): (T & { group?: { n: number; open: number } })[] {
  const ids = new Set(bars.map((b) => `${b.lane} ${b.id}`)),
    order: string[] = [],
    members = new Map<string, T[]>();
  for (const b of bars) {
    const c = categoryOf(b.id),
      k = c ? `${b.lane} ${c}` : `${b.lane} ${b.id}`;
    if (!members.has(k)) {
      members.set(k, []);
      order.push(k);
    }
    members.get(k)!.push(b);
  }
  const out: (T & { group?: { n: number; open: number } })[] = [];
  for (const k of order) {
    const ms = members.get(k)!,
      [lane, id] = [k.slice(0, k.indexOf(" ")), k.slice(k.indexOf(" ") + 1)];
    const own = ms.find((b) => b.id === id),
      rest = ms.filter((b) => b !== own);
    if (own) out.push(own);
    else if (!ids.has(k) && !known?.has(id) && rest.length > 1 && categoryOf(rest[0]!.id)) {
      const open = rest.filter((b) => isActive(b)).length,
        ends = rest.map((b) => b.b ?? b.due);
      out.push({
        id,
        lane,
        name: id.split("/")[2],
        a: Math.min(...rest.map(startOf)),
        due: Math.max(...rest.map((b) => b.due)),
        ...(open || rest.some((b) => b.b === undefined && !b.stale)
          ? {}
          : { b: Math.max(...ends), outcome: rest.every((b) => b.outcome === "verified") ? "verified" : undefined }),
        ...(rest.every((b) => b.planned) ? { planned: true } : {}),
        group: { n: rest.length, open },
      } as unknown as T & { group: { n: number; open: number } });
    }
    out.push(...rest);
  }
  return out;
}

/**
 * one lane's rows as a tree, flattened depth-first: a row's parent is the row with the longest id that prefixes it
 * ("<parent>/…"); children follow their parent directly, in their original order; depth is for indenting
 */
export function treeOrder<T extends GanttBar>(rows: T[]): { bar: T; depth: number }[] {
  const byId = new Map<string, T>(),
    kids = new Map<T | undefined, T[]>();
  for (const r of rows) if (!byId.has(r.id)) byId.set(r.id, r);
  for (const r of rows) {
    let p: T | undefined,
      id = r.id;
    for (let i = id.lastIndexOf("/"); i > 0; i = id.lastIndexOf("/")) {
      id = id.slice(0, i);
      const q = byId.get(id);
      if (q && q !== r) {
        p = q;
        break;
      }
    }
    kids.set(p, [...(kids.get(p) ?? []), r]);
  }
  const out: { bar: T; depth: number }[] = [],
    seen = new Set<T>();
  const walk = (p: T | undefined, depth: number) => {
    for (const c of kids.get(p) ?? []) {
      if (seen.has(c)) continue;
      seen.add(c);
      out.push({ bar: c, depth });
      walk(c, depth + 1);
    }
  };
  walk(undefined, 0);
  return out;
}
