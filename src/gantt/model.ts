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
