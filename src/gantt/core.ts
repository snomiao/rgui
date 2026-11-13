/**
 * rgui gantt — HEADLESS core (taku 11-11 «先抽一层无头组件…操作是公用的…客户只管渲染»).
 *
 * GanttController owns the state and every operation; a renderer only draws:
 *   - data: setBars(rows); rows form one tree by id (children under parents, across groups), categories fold
 *     by default unless something in them is active, folds the user changes are remembered (foldKey)
 *   - view: time ↔ x (linear, or a symmetric log axis around now), scroll (content px), zoom at a point
 *     (keeps the time under the cursor / fingers), endless axis (recentres near an edge), today / fit
 *   - toggle(id) fold, open(row) selection
 *   - for drawing: visibleRows(), x(t) / t(x) in viewport px, axis() ticks + now-line, frame() = all of it with
 *     each bar's parts already in px
 *   - events: "change" (rows changed: fold, data), "view" (scroll or zoom; renderers sync scroll position from
 *     scrollX/scrollY: a recentre moves it), "open" (a row was opened)
 *   - "focus" (the focused task changed: crosshair, hover via focusAt(y), or setFocus)
 * Hooks: `arrange(lines)` reorders / pads the rows after every layout (stable slots, see layout.ts), `dy(i)` offsets
 * a row's y (animations); `{ blank: true }` lines are empty rows. Hit-testing (hitTest), milestones, status marks and
 * desired slots (setDesires) are in frame() too. No DOM: persistence goes through `storage` (default: localStorage
 * when there is one), timers through setTimeout only.
 * The DOM renderer (canvas.ts: GanttChart, bindInput) lives on the `@snomiao/rgui/gantt/canvas` subpath.
 */
import {
  GANTT_COLORS,
  type GanttBar,
  type GanttSegment,
  type GanttState,
  type GanttView,
  MAX_SPP,
  MIN_SPP,
  PACE_COLORS,
  categorize,
  categoryOf,
  dur,
  endOf,
  fitView,
  groupRows,
  isActive,
  paceOf,
  segmentsOf,
  startOf,
  tickLabel,
  tickStep,
  ticks,
  treeOrder,
} from "./model";
import type { GanttSourceBar, GanttStatuses } from "./source";
import { type GanttDesire, type GanttHit, desireAnswered, hitPart } from "./interact";

/** a bar may carry extra display flags */
export type GanttRow = GanttBar & { blocked?: boolean; what?: string } & Partial<
    Pick<GanttSourceBar, "status" | "undated" | "milestone" | "deps">
  >;

/** one row of the chart: a group header (lane) or a task */
export type GanttLine = {
  lane?: string;
  bar?: GanttRow;
  segs: GanttSegment[];
  /** a folded row's hidden descendants, each in a thin sub-lane k of subLanes */
  slices?: { segs: GanttSegment[]; k: number }[];
  subLanes?: number;
  /** nesting under its parent row (indent) */
  depth?: number;
  /** a child owned by another group than the header above it */
  otherLane?: string;
  /** has children (shows a fold toggle) and is folded now */
  hasKids?: boolean;
  folded?: boolean;
  /** an empty row (a free slot left by `arrange`, e.g. stableSlots): drawn as nothing */
  blank?: boolean;
  /** a stable identity for the row when it is not a task or a group header (e.g. a repeated header) */
  key?: string;
};

/** a dated point not tied to a task row (a release, a deadline): drawn across the chart */
export type GanttMilestone = { id: string; t: number; name?: string; status?: string };

/** the minimal key/value store the controller remembers folds and focus in (localStorage fits) */
export type GanttStorage = {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
  removeItem(k: string): void;
};

export type GanttCoreOptions = {
  rowHeight?: number;
  tzOffset?: number;
  /** clock in epoch seconds (tests) */
  now?: () => number;
  /** symmetric log time axis around now */
  log?: boolean;
  statuses?: GanttStatuses;
  /** localStorage key for the folds the user opened or closed (per device); null = do not remember */
  foldKey?: string | null;
  /**
   * focus crosshair (taku 11-11 «准星线…拖到屏幕中间表示聚焦这项»): the row under the vertical middle of the
   * viewport is the focused task (after scrolling settles, with a small snap); the list gets half a viewport of
   * empty space at top and bottom so every row can reach it (default true)
   */
  crosshair?: boolean;
  /** localStorage key for the focused task (per device); null = do not remember */
  focusKey?: string | null;
  /** where folds and focus are remembered (default: globalThis.localStorage when present; null = nowhere) */
  storage?: GanttStorage | null;
  /** reorder / pad the rows after every layout (see stableSlots in layout.ts) */
  arrange?: (lines: GanttLine[]) => GanttLine[];
};

export type GanttAxisTick = { x: number; label: string };
export type GanttPart = {
  x: number;
  w: number;
  part: GanttSegment["part"];
  state: GanttState;
  color: string;
  /** sub-lane (slices of a folded row) */
  k?: number;
};
export type GanttFrameRow = {
  index: number;
  /** top in viewport px (0 = the first row's top when scrollY = 0) */
  y: number;
  line: GanttLine;
  parts: GanttPart[];
  /** progress underline */
  progress?: { x: number; w: number; color: string };
  milestoneX?: number;
  /** the first plan (a0..due0) as a faint ghost, when it moved */
  ghost?: { x: number; w: number };
  /** the status from the statuses map, with its non-colour mark (✓ ▶ ■ ○ …) */
  status?: { key: string; label: string; color: string; mark?: string };
  /** the desired slot set for this row (setDesires), in viewport px */
  desire?: { x: number; w: number; a: number; b: number };
};
export type GanttFrame = {
  width: number;
  height: number;
  rowHeight: number;
  rows: GanttFrameRow[];
  ticks: GanttAxisTick[];
  nowX: number;
  /** the crosshair's y (viewport middle) and the focused row's index, when any */
  crosshairY?: number;
  focusIndex?: number;
  /** standalone milestones (setMilestones) in view, x in viewport px */
  milestones: (GanttMilestone & { x: number; color?: string; mark?: string })[];
};

type Ev = "change" | "view" | "open" | "focus";

const defaultStorage = (): GanttStorage | null => {
  try {
    return (globalThis as { localStorage?: GanttStorage }).localStorage ?? null;
  } catch {
    return null;
  }
};

export const SCREENS = 7;
/** log axis labels: offsets from now */
const LOG_STEPS = [
  300,
  900,
  3600,
  3 * 3600,
  6 * 3600,
  12 * 3600,
  86400,
  2 * 86400,
  7 * 86400,
  14 * 86400,
  30 * 86400,
  91 * 86400,
  365 * 86400,
];

export class GanttController {
  readonly o: Required<
    Omit<GanttCoreOptions, "statuses" | "foldKey" | "focusKey" | "storage" | "arrange">
  > & {
    statuses?: GanttStatuses;
  };
  /** reorder / pad rows after every layout (stable slots); set before setBars */
  arrange?: (lines: GanttLine[]) => GanttLine[];
  /** extra y offset of row i in px (animations: FLIP rows to their new slot); rowY adds it */
  dy?: (i: number) => number;
  /** standalone milestones */
  milestones: GanttMilestone[] = [];
  /** desired slots by "<lane> <id>" (drag-to-propose shadows) */
  desires: Record<string, GanttDesire> = {};
  private store: GanttStorage | null;
  /** the focused task ("<lane> <id>"), the row under the crosshair */
  focus?: string;
  private focusKey: string | null = "rgui-gantt-focus";
  private settle?: ReturnType<typeof setTimeout>;
  private restored = false;
  bars: GanttRow[] = [];
  lines: GanttLine[] = [];
  /** viewport size in px (the rows area: below a renderer's own header) */
  W = 800;
  H = 600;
  /** scroll position in content px: the content is SCREENS × W wide and lines × rowHeight tall */
  scrollX = 0;
  scrollY = 0;
  spp = 60;
  /** content x = 0 is this time (linear) */
  T0 = 0;
  /** log axis: now when the mapping was set */
  N = 0;
  lo = 0;
  hi = 0;
  opened?: GanttRow;
  /** the first data set has fitted the view (renderers wait for it before filtering by view) */
  fitted = false;
  private rowOf = new Map<string, number>();
  private foldKey: string | null = "rgui-gantt-fold";
  private userFold: Record<string, boolean> = {};
  private ls = new Map<Ev, Set<(x?: unknown) => void>>();

  constructor(opts: GanttCoreOptions = {}) {
    this.o = {
      rowHeight: opts.rowHeight ?? 26,
      tzOffset: opts.tzOffset ?? 32400,
      now: opts.now ?? (() => Date.now() / 1000),
      log: opts.log ?? false,
      statuses: opts.statuses,
      crosshair: opts.crosshair ?? true,
    };
    this.arrange = opts.arrange;
    this.store = opts.storage === undefined ? defaultStorage() : opts.storage;
    if (opts.focusKey !== undefined) this.focusKey = opts.focusKey;
    if (this.focusKey)
      try {
        this.focus = this.store?.getItem(this.focusKey) || undefined;
      } catch {}
    if (opts.foldKey !== undefined) this.foldKey = opts.foldKey;
    if (this.foldKey)
      try {
        this.userFold = JSON.parse(this.store?.getItem(this.foldKey) || "{}");
      } catch {}
    this.N = this.o.now();
  }

  // ---- events
  on(ev: Ev, fn: (x?: unknown) => void): () => void {
    if (!this.ls.has(ev)) this.ls.set(ev, new Set());
    this.ls.get(ev)!.add(fn);
    return () => this.ls.get(ev)?.delete(fn);
  }
  private emit(ev: Ev, x?: unknown) {
    for (const f of this.ls.get(ev) ?? []) f(x);
  }

  // ---- data and rows
  setBars(bars: GanttRow[]) {
    const v = this.view;
    this.bars = bars;
    const n = this.o.now();
    if (!this.o.log) this.N = n;
    this.lo = Math.min(n, ...bars.map(startOf));
    this.hi = Math.max(n, ...bars.map((b) => endOf(b, n)));
    this.relines();
    this.emit("change");
    if (!this.fitted && bars.length) {
      this.fitted = true;
      const spp =
        openSpp(bars, n, this.W) ?? Math.min(86400 / this.W, fitView(this.lo, this.hi, this.W).spp);
      this.setView({ t0: n - (this.W / 2) * spp, spp });
    } else this.setView(v);
    // first data: put the remembered focus under the crosshair
    if (!this.restored && this.lines.length && this.o.crosshair) {
      this.restored = true;
      const i = this.focusRow();
      if (i !== undefined) this.scrollTo(this.scrollX, this.centreY(i), true);
      else this.settleSoon();
    }
  }

  /** fold or unfold a row's descendants; remembered per device */
  toggle(lane: string, id: string) {
    const k = `${lane} ${id}`,
      ln = this.lines[this.rowOf.get(id) ?? -1];
    this.userFold[k] = !(ln?.bar?.lane === lane && ln.folded);
    if (this.foldKey)
      try {
        this.store?.setItem(this.foldKey, JSON.stringify(this.userFold));
      } catch {}
    this.relines();
    this.emit("change");
    this.emit("view");
  }

  /** select / open a row (the renderer shows details) */
  open(bar: GanttRow) {
    this.opened = bar;
    this.emit("open", bar);
  }

  private relines() {
    const n = this.o.now();
    this.lines = [];
    // one tree by id across lanes: a child sits right under its parent even when another lane owns it
    const known = new Set(this.bars.map((b) => b.id)),
      all = groupRows(this.bars).flatMap((g) => categorize(g.bars as GanttRow[], known)),
      tree = treeOrder(all);
    // categories fold by default unless a descendant is started, overdue or blocked; user choices win
    const active = new Set<number>();
    for (let i = 0; i < tree.length; i++) {
      if (!isActive(tree[i]!.bar)) continue;
      for (let j = i - 1, d = tree[i]!.depth; j >= 0 && d > 0; j--)
        if (tree[j]!.depth < d) {
          active.add(j);
          d = tree[j]!.depth;
        }
    }
    let lane: string | undefined,
      hideBelow = Infinity;
    for (let i = 0; i < tree.length; i++) {
      const { bar: b, depth } = tree[i]!,
        k = `${b.lane} ${b.id}`,
        hasKids = (tree[i + 1]?.depth ?? -1) > depth;
      if (depth <= hideBelow) hideBelow = Infinity;
      else continue; // under a folded row
      const isCat = !categoryOf(b.id) && b.id.split("/").length === 3,
        fold = hasKids && (this.userFold[k] ?? (isCat && !active.has(i)));
      if (depth === 0 && b.lane !== lane) {
        lane = b.lane;
        this.lines.push({ lane, segs: [] });
      }
      const ln: GanttLine = {
        bar: b,
        segs: b.undated ? [] : segmentsOf(b, n),
        depth,
        hasKids,
        folded: fold,
      };
      if (depth > 0 && b.lane !== lane) ln.otherLane = b.lane;
      if (fold) {
        hideBelow = depth;
        const kids: GanttRow[] = [];
        for (let j = i + 1; j < tree.length && tree[j]!.depth > depth; j++) kids.push(tree[j]!.bar);
        const { slices, n: lanes } = packSlices(kids, n);
        ln.slices = slices;
        ln.subLanes = lanes;
      }
      this.lines.push(ln);
    }
    if (this.arrange) this.lines = this.arrange(this.lines);
    this.rowOf = new Map();
    this.lines.forEach((l, i) => l.bar && this.rowOf.set(l.bar.id, i));
  }

  /** row index of a task id among the shown rows */
  indexOf(id: string) {
    return this.rowOf.get(id);
  }

  // ---- size and scroll
  get contentWidth() {
    return SCREENS * this.W;
  }
  /** empty space above the first row and below the last (half the viewport with the crosshair) */
  get pad() {
    return this.o.crosshair ? Math.floor(this.H / 2) : 0;
  }
  get contentHeight() {
    return this.lines.length * this.o.rowHeight + 2 * this.pad;
  }
  /** a row's top in content px (renderers that scroll natively) */
  rowTop(i: number) {
    return this.pad + i * this.o.rowHeight;
  }
  /** a row's top in viewport px */
  rowY(i: number) {
    return this.rowTop(i) - this.scrollY + (this.dy?.(i) ?? 0);
  }

  /** the row index at viewport y (no dy), or undefined outside the rows */
  rowAt(y: number): number | undefined {
    const i = Math.floor((y + this.scrollY - this.pad) / this.o.rowHeight);
    return i >= 0 && i < this.lines.length ? i : undefined;
  }

  /**
   * what is under viewport point (x, y): the row, its task, the time there, and which part of the bar
   * ("start" / "end" edge within `edge` px on bars wider than 16 px, "body", or "none" off the bar)
   */
  hitTest(x: number, y: number, edge = 6): GanttHit | undefined {
    const index = this.rowAt(y);
    if (index === undefined) return undefined;
    const line = this.lines[index]!,
      bar = line.bar,
      t = this.t(x);
    if (!bar || line.blank) return { index, line, t, part: "none" };
    if (bar.undated) return { index, line, bar, t, part: "none" };
    const x0 = this.x(startOf(bar)),
      x1 = this.x(endOf(bar, this.o.now()));
    return { index, line, bar, t, x0, x1, part: hitPart(x, x0, x1, edge) };
  }

  /** hover focus (a pointer that can hover): focus the task row at viewport y; a header or blank row keeps focus */
  focusAt(y: number) {
    const i = this.rowAt(y),
      b = i === undefined ? undefined : this.lines[i]?.bar;
    if (b) this.setFocusKey(`${b.lane} ${b.id}`);
    return b;
  }

  /** standalone milestones (a release date, a deadline); frame().milestones places them */
  setMilestones(ms: GanttMilestone[]) {
    this.milestones = ms;
    this.emit("change");
  }

  /**
   * desired slots ("<lane> <id>" → desire): frame rows carry them as `desire`. Desires whose task was re-planned
   * (its start or due moved since the desire was made) are dropped; returns the keys that were dropped.
   */
  setDesires(d: Record<string, GanttDesire>): string[] {
    const gone: string[] = [];
    this.desires = { ...d };
    for (const b of this.bars) {
      const k = `${b.lane} ${b.id}`,
        w = this.desires[k];
      if (w && desireAnswered(w, b)) {
        delete this.desires[k];
        gone.push(k);
      }
    }
    this.emit("change");
    return gone;
  }

  // ---- focus: the row under the crosshair (the vertical middle of the viewport)
  /** the row index under the crosshair now */
  crosshairRow() {
    const i = Math.floor((this.scrollY + this.H / 2 - this.pad) / this.o.rowHeight);
    return Math.max(0, Math.min(this.lines.length - 1, i));
  }
  /** focus a task: scrolls its row (or its folded ancestor's) under the crosshair */
  setFocus(bar: GanttRow | undefined) {
    if (!bar) return this.setFocusKey(undefined);
    const i = this.shownIndex(bar);
    if (i !== undefined && this.o.crosshair) this.scrollTo(this.scrollX, this.centreY(i));
    this.setFocusKey(`${bar.lane} ${bar.id}`);
  }
  /** the focused row's index among the shown rows (a hidden task shows through its folded ancestor) */
  focusRow(): number | undefined {
    if (!this.focus) return undefined;
    const sp = this.focus.indexOf(" "),
      bar = { lane: this.focus.slice(0, sp), id: this.focus.slice(sp + 1) } as GanttRow;
    return this.shownIndex(bar);
  }
  private shownIndex(bar: Pick<GanttRow, "id">) {
    for (let id = bar.id; id; id = id.slice(0, Math.max(0, id.lastIndexOf("/")))) {
      const i = this.rowOf.get(id);
      if (i !== undefined) return i;
    }
    return undefined;
  }
  /** i itself when it is a task row, else the closest task row (a header has none) */
  private nearestTask(i: number) {
    for (let d = 0; d < this.lines.length; d++) {
      if (this.lines[i - d]?.bar) return i - d;
      if (this.lines[i + d]?.bar) return i + d;
    }
    return i;
  }
  private centreY(i: number) {
    return this.rowTop(i) + this.o.rowHeight / 2 - this.H / 2;
  }
  /** focus by "<lane> <id>" without scrolling (hover focus); emits "focus" */
  setFocusKey(k: string | undefined) {
    if (k === this.focus) return;
    this.focus = k;
    if (this.focusKey)
      try {
        if (k) this.store?.setItem(this.focusKey, k);
        else this.store?.removeItem(this.focusKey);
      } catch {}
    const i = this.focusRow();
    this.emit("focus", i === undefined ? undefined : this.lines[i]?.bar);
  }
  /** after scrolling settles: snap the row under the crosshair to its middle and focus it */
  private settleSoon() {
    if (!this.o.crosshair || !this.lines.length) return;
    clearTimeout(this.settle);
    this.settle = setTimeout(() => {
      // the row under the crosshair, or the nearest task row when that is a group header
      const i = this.nearestTask(this.crosshairRow()),
        b = this.lines[i]?.bar,
        y = this.centreY(i),
        far = Math.abs(y - this.scrollY);
      if (far > 0.5 && (far < this.o.rowHeight || !this.lines[this.crosshairRow()]?.bar))
        this.scrollTo(this.scrollX, y, true);
      if (b) this.setFocusKey(`${b.lane} ${b.id}`);
    }, 160);
  }

  setViewport(w: number, h: number) {
    if (w === this.W && h === this.H) return;
    const v = this.view;
    this.W = Math.max(1, w);
    this.H = Math.max(1, h);
    this.setView(v);
  }

  /** the renderer's scroll position changed (native scroll) or a pan moved it; recentres the endless axis */
  scrollTo(x: number, y: number, settled = false) {
    this.scrollX = x;
    this.scrollY = Math.max(0, Math.min(y, Math.max(0, this.contentHeight - this.H)));
    this.edges();
    this.emit("view");
    if (!settled) this.settleSoon();
  }
  panBy(dx: number, dy: number) {
    this.scrollTo(
      Math.max(0, Math.min(this.contentWidth - this.W, this.scrollX + dx)),
      this.scrollY + dy,
    );
  }

  // ---- time ↔ x. linear: content x = (t - T0) / spp. log: now sits in the middle C of the content; the slope
  // there is 1/spp and it flattens with distance: x = C ± L·ln(1 + |t - now| / (L·spp)), L = W/6
  get log() {
    return this.o.log;
  }
  /** time → content px */
  cx(t: number) {
    if (!this.o.log) return (t - this.T0) / this.spp;
    const d = t - this.N,
      L = this.W / 6;
    return this.contentWidth / 2 + Math.sign(d) * L * Math.log1p(Math.abs(d) / (L * this.spp));
  }
  /** content px → time */
  ct(x: number) {
    if (!this.o.log) return this.T0 + x * this.spp;
    const d = x - this.contentWidth / 2,
      L = this.W / 6;
    return this.N + Math.sign(d) * L * this.spp * Math.expm1(Math.abs(d) / L);
  }
  /** time → x in viewport px */
  x(t: number) {
    return this.cx(t) - this.scrollX;
  }
  /** viewport px → time */
  t(x: number) {
    return this.ct(x + this.scrollX);
  }
  /** time → x in content px (renderers that scroll natively place things in content coordinates) */
  contentX(t: number) {
    return this.cx(t);
  }

  get view(): GanttView {
    if (this.o.log) return { t0: this.ct(this.scrollX), spp: this.spp };
    return { t0: this.T0 + this.scrollX * this.spp, spp: this.spp };
  }

  setView(v: GanttView) {
    this.spp = Math.min(MAX_SPP, Math.max(MIN_SPP, v.spp));
    if (this.o.log) {
      // keep N (the log anchor) and put v.t0 at the left edge; only today()/fit() recentre on now
      this.scrollX = Math.max(0, Math.min(this.contentWidth - this.W, this.cx(v.t0)));
      return this.emit("view");
    }
    const mid = ((SCREENS - 1) / 2) * this.W;
    this.T0 = v.t0 - mid * this.spp;
    this.scrollX = mid;
    this.emit("view");
  }

  setLog(on: boolean) {
    this.o.log = on;
    this.N = this.o.now();
    this.today();
  }

  today() {
    if (this.o.log) {
      this.N = this.o.now();
      this.scrollX = this.contentWidth / 2 - this.W / 2;
      return this.emit("view");
    }
    this.setView({ t0: this.o.now() - (this.W / 2) * this.spp, spp: this.spp });
  }

  fit() {
    if (this.o.log) {
      const far = Math.max(this.N - this.lo, this.hi - this.N, 3600),
        L = this.W / 6;
      this.spp = Math.min(
        MAX_SPP,
        Math.max(MIN_SPP, far / (L * Math.expm1((this.W / 2 - 24) / L))),
      );
      return this.today();
    }
    this.setView(fitView(this.lo, this.hi, this.W));
  }

  /** zoom by k (>1 = in) keeping the time under viewport x fixed */
  zoomAt(x: number, k: number) {
    const t = this.t(x),
      spp = Math.min(MAX_SPP, Math.max(MIN_SPP, this.spp / k));
    if (spp === this.spp) return;
    this.spp = spp;
    if (this.o.log) this.scrollX = this.cx(t) - x;
    else this.T0 = t - (this.scrollX + x) * spp;
    this.emit("view");
  }

  /** endless axis: near an edge the origin moves and scrollX jumps back by the same amount */
  private edges() {
    if (this.o.log) return;
    const sl = this.scrollX,
      W = this.W,
      mid = ((SCREENS - 1) / 2) * W,
      t0 = this.T0 + sl * this.spp,
      t1 = t0 + W * this.spp,
      room = W * this.spp;
    if ((sl < W && t0 > this.lo - room) || (sl > (SCREENS - 2) * W && t1 < this.hi + room)) {
      const dx = sl - mid;
      this.T0 += dx * this.spp;
      this.scrollX -= dx;
    }
  }

  // ---- what to draw
  /** rows in view (+ overscan rows each side) */
  visibleRows(overscan = 0): [number, number] {
    const H = this.o.rowHeight;
    return [
      Math.max(0, Math.floor((this.scrollY - this.pad) / H) - overscan),
      Math.min(this.lines.length - 1, Math.ceil((this.scrollY + this.H - this.pad) / H) + overscan),
    ];
  }

  /** the time span in view: [t(0), t(W)] (in-view filters, data paging) */
  timeSpan(): { from: number; to: number } {
    return { from: this.t(0), to: this.t(this.W) };
  }

  /** axis ticks over [x0, x1] content px (default: the whole content); x is content px */
  axis(x0 = 0, x1 = this.contentWidth): { ticks: GanttAxisTick[]; step?: number } {
    const tz = this.o.tzOffset;
    if (this.o.log) {
      const C = this.contentWidth / 2,
        out: GanttAxisTick[] = [];
      for (const d of LOG_STEPS)
        for (const sg of [-1, 1]) {
          const x = this.cx(this.N + sg * d);
          if (x < x0 || x > x1 || Math.abs(x - C) < 44) continue;
          out.push({ x, label: `${sg > 0 ? "+" : ""}${dur(sg * d)}` });
        }
      const kept = out
        .sort((a, b) => Math.abs(a.x - C) - Math.abs(b.x - C))
        .filter((e, i, all) => all.slice(0, i).every((o) => Math.abs(o.x - e.x) > 44));
      return { ticks: [{ x: C, label: hm(this.N, tz) }, ...kept] };
    }
    const step = tickStep(this.spp);
    return {
      step,
      ticks: ticks(this.ct(x0), this.ct(x1), step, tz).map((t) => ({
        x: this.cx(t),
        label: tickLabel(t, step, tz),
      })),
    };
  }

  colorOf(b: GanttRow | undefined, s: GanttSegment) {
    return (
      (s.part !== "late" && b?.status && this.o.statuses?.[b.status]?.color) ||
      GANTT_COLORS[s.state]
    );
  }

  /** everything a custom renderer needs for the rows in view, in viewport px */
  frame(overscan = 0): GanttFrame {
    const H = this.o.rowHeight,
      n = this.o.now(),
      [a, z] = this.visibleRows(overscan),
      rows: GanttFrameRow[] = [];
    const part = (b: GanttRow | undefined, s: GanttSegment, k?: number): GanttPart => {
      const x0 = this.x(s.from),
        x1 = Math.max(x0 + 2, this.x(s.to));
      return { x: x0, w: x1 - x0, part: s.part, state: s.state, color: this.colorOf(b, s), k };
    };
    for (let i = a; i <= z; i++) {
      const line = this.lines[i]!,
        b = line.bar,
        r: GanttFrameRow = { index: i, y: this.rowY(i), line, parts: [] };
      if (line.slices?.length)
        for (const sl of line.slices) for (const s of sl.segs) r.parts.push(part(b, s, sl.k));
      else for (const s of line.segs) r.parts.push(part(b, s));
      const pace = b && paceOf(b, n);
      if (b && pace) {
        const u0 = this.x(b.a);
        r.progress = {
          x: u0,
          w: this.x(b.a + b.progress! * Math.max(60, b.due - b.a)) - u0,
          color: PACE_COLORS[pace],
        };
      }
      if (b?.milestone && !b.undated) r.milestoneX = this.x(b.due);
      if (b && !b.planned && b.due0 !== undefined && (b.due0 !== b.due || (b.a0 ?? b.a) !== b.a)) {
        const g0 = this.x(b.a0 ?? b.a);
        r.ghost = { x: g0, w: Math.max(2, this.x(b.due0) - g0) };
      }
      const st = b?.status ? this.o.statuses?.[b.status] : undefined;
      if (b?.status && st)
        r.status = { key: b.status, label: st.label, color: st.color, mark: st.mark };
      const want = b && this.desires[`${b.lane} ${b.id}`];
      if (want) {
        const d0 = this.x(want.a);
        r.desire = { x: d0, w: Math.max(4, this.x(want.b) - d0), a: want.a, b: want.b };
      }
      rows.push(r);
    }
    const ax = this.axis(this.scrollX - 60, this.scrollX + this.W + 60);
    return {
      width: this.W,
      height: this.H,
      rowHeight: H,
      rows,
      ticks: ax.ticks.map((t) => ({ x: t.x - this.scrollX, label: t.label })),
      nowX: this.x(n),
      crosshairY: this.o.crosshair ? this.H / 2 : undefined,
      focusIndex: this.focusRow(),
      milestones: this.milestones.flatMap((m) => {
        const x = this.x(m.t),
          st = m.status ? this.o.statuses?.[m.status] : undefined;
        return x < -60 || x > this.W + 60 ? [] : [{ ...m, x, color: st?.color, mark: st?.mark }];
      }),
    };
  }
}

function hm(t: number, tz: number) {
  const d = new Date((t + tz) * 1000),
    p = (x: number) => String(x).padStart(2, "0");
  return `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

/** pack sub-tasks into the fewest sub-lanes so overlapping ones never cover each other */
export function packSlices(kids: GanttRow[], now: number) {
  const ends: number[] = [],
    slices: { segs: GanttSegment[]; k: number }[] = [];
  for (const c of [...kids].sort((x, y) => startOf(x) - startOf(y))) {
    if (c.undated) continue;
    const segs = segmentsOf(c, now),
      a = Math.min(...segs.map((s) => s.from)),
      b = Math.max(...segs.map((s) => s.to));
    let k = ends.findIndex((e) => e <= a);
    if (k < 0) k = ends.push(b) - 1;
    else ends[k] = b;
    slices.push({ segs, k });
  }
  return { slices, n: ends.length };
}

/** open zoom: the soonest-ending open task and its neighbours (±5 by end); their P95 span fills ~3/4 of the width */
export function openSpp(bars: GanttBar[], now: number, width: number): number | undefined {
  const open = bars
    .filter((b) => !b.planned && !b.stale && b.b === undefined && !(b as GanttRow).wait)
    .sort((x, y) => x.due - y.due);
  if (!open.length) return undefined;
  let i = open.findIndex((b) => b.due >= now);
  if (i < 0) i = open.length - 1;
  const spans = open
      .slice(Math.max(0, i - 5), i + 6)
      .map((b) => Math.max(60, b.due - b.a))
      .sort((x, y) => x - y),
    p95 = spans[Math.min(spans.length - 1, Math.ceil(spans.length * 0.95) - 1)]!;
  return Math.min(MAX_SPP, Math.max(MIN_SPP, p95 / (0.75 * width)));
}
