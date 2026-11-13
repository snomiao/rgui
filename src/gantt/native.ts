/**
 * rgui gantt — view on a NATIVE scroll container (taku 11-09: drag must be
 * smooth in every direction). The time header is position:sticky top, each
 * row's name position:sticky left (always at the left edge of what you see),
 * bars a see-through band under it.
 *
 * Bars are DOM (placed with CSS variables: left = (a - --o) * --k px, so a
 * zoom or a recentre changes two numbers, not every node) or, with
 * `canvas`, drawn on one viewport-sized canvas behind the names, redrawn in
 * rAF from scrollLeft/scrollTop. `virtual` keeps only the rows in view (plus a
 * screen of overscan) in the DOM. `freePan` (default on) takes over touch
 * drags (touch-action:none) so a diagonal swipe moves both axes at once, with
 * momentum; native one-container scrolling locks to one axis on iOS/Android.
 *
 * Endless time axis: the inner layer is SCREENS screens wide; near an edge the
 * time origin moves and scrollLeft jumps back by the same amount, stopping a
 * screen past the data.
 * Zoom: ctrl+wheel / trackpad pinch, Safari gesture events, two-finger pinch;
 * the time under the cursor / the fingers' midpoint stays put.
 */
import {
  GANTT_COLORS,
  dur,
  endOf,
  paceOf,
  PACE_COLORS,
  startOf,
  stateOf,
  type GanttView,
} from "./model";
import { GanttController, SCREENS, type GanttLine, type GanttRow } from "./core";
import { bindInput } from "./input";
import type { GanttStatuses } from "./source";

export type GanttLabels = {
  /** state → people-facing word (tooltips / badges) */
  states?: Partial<Record<string, string>>;
  now?: string;
  blocked?: string;
  empty?: string;
  fold?: string;
  unfold?: string;
  open?: string;
  /** waiting badge: "{d}" = how long it has waited */
  wait?: string;
  /** tooltip: "{d}" = how long ago the estimate was confirmed */
  confirmed?: string;
};

export type GanttOptions = {
  rowHeight?: number;
  tzOffset?: number;
  labels?: GanttLabels;
  /** clock in epoch seconds (tests) */
  now?: () => number;
  /** only the rows in view (+ overscan) are in the DOM (default true) */
  virtual?: boolean;
  /** bars on one canvas instead of DOM nodes (default true) */
  canvas?: boolean;
  /** own touch pan: free diagonal drag with momentum (default true) */
  freePan?: boolean;
  /** symmetric log time axis around now (canvas only): minutes near now and weeks away on one screen */
  log?: boolean;
  /** a ⋯ button at the right end of each row calls this (the page opens its dialog) */
  onOpen?: (bar: GanttRow) => void;
  /** status → colour / label (the adapter's statuses: any task source's own values) */
  statuses?: GanttStatuses;
  /** localStorage key for the folds the user opened or closed (per device); null = do not remember */
  foldKey?: string | null;
  /** focus crosshair at the vertical middle (default true); the row under it is the focused task */
  crosshair?: boolean;
  /** localStorage key for the focused task; null = do not remember */
  focusKey?: string | null;
  /** the focused task changed (the row under the crosshair, or a tapped row) */
  onFocus?: (bar: GanttRow | undefined) => void;
};

/** built-in label sets; pass one (or your own) as options.labels */
export const LABELS_EN: Required<GanttLabels> = {
  states: {
    verified: "verified",
    unverified: "done · unverified",
    open: "in progress",
    late: "past ETA",
    stale: "not closed",
    planned: "planned",
    human: "waiting on a person",
    lane: "waiting on a lane",
    cancel: "cancelled",
  },
  now: "now",
  blocked: "blocked",
  empty: "no tasks",
  fold: "Fold sub-tasks",
  unfold: "Unfold sub-tasks",
  open: "Details",
  wait: "waiting {d}",
  confirmed: "confirmed {d} ago",
};
export const LABELS_JA: Required<GanttLabels> = {
  states: {
    verified: "検証済み",
    unverified: "完了・未検証",
    open: "進行中",
    late: "ETA 超過",
    stale: "未クローズ",
    planned: "予定",
    human: "人待ち",
    lane: "レーン待ち",
    cancel: "取消",
  },
  now: "現在",
  blocked: "ブロック",
  empty: "タスクなし",
  fold: "サブタスクを折りたたむ",
  unfold: "サブタスクを展開",
  open: "詳細",
  wait: "待機 {d}",
  confirmed: "{d} 前に確認",
};
export const LABELS_ZH: Required<GanttLabels> = {
  states: {
    verified: "已验证",
    unverified: "完成·未验证",
    open: "进行中",
    late: "超过 ETA",
    stale: "未关闭",
    planned: "计划",
    human: "等人",
    lane: "等 lane",
    cancel: "取消",
  },
  now: "现在",
  blocked: "阻塞",
  empty: "没有任务",
  fold: "收起子任务",
  unfold: "展开子任务",
  open: "详情 / 发消息",
  wait: "等待 {d}",
  confirmed: "{d} 前确认",
};

const AXIS_H = 24;

const CSS = `
.rg-gantt{position:relative;width:100%;height:100%;overflow:auto;font:13px system-ui,sans-serif;color:#222;background:#fff;touch-action:pan-x pan-y;overscroll-behavior:contain}
.rg-gantt.rg-free{touch-action:none}
.rg-gantt .rg-inner{position:relative;overflow-x:clip;min-height:100%;--o:0;--k:0.01}
.rg-gantt .rg-axis{position:sticky;top:0;height:${AXIS_H}px;background:#f4f3ee;border-bottom:1px solid #ddd;z-index:4;contain:strict}
.rg-gantt .rg-tick{position:absolute;top:5px;font-size:11px;color:#666;transform:translateX(-50%);white-space:nowrap}
.rg-gantt .rg-cvw{position:sticky;left:0;top:${AXIS_H}px;height:0;z-index:0}
.rg-gantt .rg-cvw canvas{position:absolute;left:0;top:0;pointer-events:none}
.rg-gantt .rg-rows{position:relative;user-select:none;-webkit-user-select:none}
.rg-gantt .rg-now{position:absolute;top:0;bottom:0;width:2px;background:#d32f2f;opacity:.7;z-index:2;pointer-events:none;left:calc((var(--n) - var(--o)) * var(--k) * 1px)}
.rg-gantt .rg-r{height:var(--h);line-height:var(--h);white-space:nowrap;position:relative;display:flex}
.rg-gantt .rg-sp{flex:1}
.rg-gantt .rg-open{position:sticky;right:0;z-index:1;border:0;background:rgba(255,255,255,.85);font:inherit;font-size:16px;line-height:1;padding:0 10px;margin:2px 2px;border-radius:4px;cursor:pointer;color:#555}
.rg-gantt .rg-fold{pointer-events:auto;border:0;background:none;font:inherit;padding:0 4px 0 0;margin-left:-12px;width:16px;cursor:pointer;color:#666}
.rg-gantt.rg-virt .rg-r{position:absolute;left:0;right:0}
.rg-gantt .rg-lane{font-weight:600;background:rgba(250,250,250,.85);border-top:1px solid #e5e5e5}
.rg-gantt .rg-seg{position:absolute;top:3px;bottom:3px;border-radius:3px;box-sizing:border-box;left:calc((var(--a) - var(--o)) * var(--k) * 1px);width:max(2px,calc(var(--d) * var(--k) * 1px))}
.rg-gantt .rg-core{opacity:.32}
.rg-gantt .rg-range{opacity:.13;border:1px dashed currentColor}
.rg-gantt .rg-late{opacity:.32;background-image:repeating-linear-gradient(45deg,transparent 0 4px,rgba(255,255,255,.6) 4px 8px)}
.rg-gantt .rg-crit{outline:2px solid #d32f2f}
.rg-gantt .rg-name{position:sticky;left:0;display:inline-block;padding:0 8px 0 14px;z-index:1;pointer-events:none;text-shadow:0 0 3px #fff,0 0 3px #fff;max-width:90vw;overflow:hidden;text-overflow:ellipsis;vertical-align:top}
.rg-gantt .rg-lane .rg-name{padding-left:6px}
.rg-gantt .rg-name i{font-style:normal;font-size:11px;margin-left:6px;padding:0 4px;border-radius:3px;color:#fff;text-shadow:none}
.rg-gantt .rg-name i.rg-wait{background:none;color:inherit;border:1px solid #8d6e63}
.rg-gantt .rg-name i.rg-count{background:none;color:inherit;opacity:.6;border:1px solid currentColor}
.rg-gantt .rg-name b{font-weight:600}
.rg-gantt .rg-desc{color:#555}
.rg-gantt .rg-empty{padding:20px;color:#888}
`;

type Line = GanttLine;

/** the default renderer: DOM rows (sticky names, fold toggles, ⋯) and one canvas for bars, on the headless core */
export class GanttChart {
  readonly root: HTMLDivElement;
  /** the headless core: state and operations (fold, pan, zoom, mapping); listen to its events */
  readonly controller: GanttController;
  /** the scrolled content layer (overlays such as desired-slot shadows go here, in content px) */
  readonly inner: HTMLDivElement;
  private axis: HTMLDivElement;
  /** the rows layer (pointer events for hover focus / drag-to-propose) */
  readonly rows: HTMLDivElement;
  private cvw?: HTMLDivElement;
  private cv?: HTMLCanvasElement;
  private base = 0;
  private Hv = 600;
  private o: {
    rowHeight: number;
    tzOffset: number;
    labels: Required<GanttLabels>;
    virtual: boolean;
    canvas: boolean;
    statuses?: GanttStatuses;
  };
  private raf = 0;
  private onOpen?: (bar: GanttRow) => void;
  private ro?: ResizeObserver;
  private axisKey = "";
  private band: [number, number] = [0, -1];
  private unbind: () => void;

  constructor(host: HTMLElement, opts: GanttOptions = {}) {
    this.o = {
      rowHeight: opts.rowHeight ?? 26,
      tzOffset: opts.tzOffset ?? 32400,
      labels: {
        ...LABELS_EN,
        ...opts.labels,
        states: { ...LABELS_EN.states, ...opts.labels?.states },
      } as Required<GanttLabels>,
      virtual: opts.virtual ?? true,
      canvas: opts.canvas ?? true,
      statuses: opts.statuses,
    };
    const c = (this.controller = new GanttController({
      rowHeight: this.o.rowHeight,
      tzOffset: this.o.tzOffset,
      now: opts.now,
      log: (opts.log ?? false) && this.o.canvas,
      statuses: opts.statuses,
      foldKey: opts.foldKey,
      crosshair: opts.crosshair,
      focusKey: opts.focusKey,
    }));
    c.on("focus", (b) => {
      this.schedule();
      opts.onFocus?.(b as GanttRow | undefined);
    });
    this.onOpen = opts.onOpen;
    if (opts.onOpen) c.on("open", (b) => opts.onOpen!(b as GanttRow));
    if (!document.getElementById("rg-gantt-css")) {
      const s = document.createElement("style");
      s.id = "rg-gantt-css";
      s.textContent = CSS;
      document.head.appendChild(s);
    }
    this.root = el("div", "rg-gantt");
    if (this.o.virtual) this.root.classList.add("rg-virt");
    if (opts.freePan ?? true) this.root.classList.add("rg-free");
    this.inner = el("div", "rg-inner");
    this.axis = el("div", "rg-axis");
    this.rows = el("div", "rg-rows");
    this.inner.append(this.axis);
    if (this.o.canvas) {
      this.cvw = el("div", "rg-cvw");
      this.cv = document.createElement("canvas");
      this.cvw.appendChild(this.cv);
      this.inner.append(this.cvw);
    }
    this.inner.append(this.rows);
    this.root.appendChild(this.inner);
    host.appendChild(this.root);
    this.root.style.setProperty("--h", `${this.o.rowHeight}px`);
    this.base = Math.round(c.o.now());
    c.on("change", () => {
      this.band = [0, -1];
      this.renderRows(true);
    });
    // a view change (scroll, zoom, recentre): CSS variables and axis now, rows and canvas in the next frame
    c.on("view", () => {
      this.apply();
      this.schedule();
    });
    this.unbind = bindInput(this.root, c, { mode: "native", freePan: opts.freePan ?? true });
    this.measure();
    if (typeof ResizeObserver !== "undefined") {
      this.ro = new ResizeObserver(() => {
        const w = this.root.clientWidth,
          h = this.root.clientHeight;
        if (!w || (w === c.W && h === this.Hv)) return;
        this.measure();
      });
      this.ro.observe(this.root);
    }
  }

  setBars(bars: GanttRow[]) {
    this.inner.style.setProperty("--n", String(this.controller.o.now() - this.base));
    this.controller.setBars(bars);
  }
  toggle(lane: string, id: string) {
    this.controller.toggle(lane, id);
  }
  /** focus a task (scrolls it under the crosshair) */
  setFocus(bar: GanttRow | undefined) {
    this.controller.setFocus(bar);
  }
  setLog(on: boolean) {
    this.controller.setLog(on && this.o.canvas);
  }
  get log() {
    return this.controller.log;
  }
  fit() {
    this.controller.fit();
  }
  today() {
    this.controller.today();
  }
  get view(): GanttView {
    return this.controller.view;
  }
  setView(v: GanttView) {
    this.controller.setView(v);
  }

  destroy() {
    this.ro?.disconnect();
    this.unbind();
    cancelAnimationFrame(this.raf);
    this.root.remove();
  }

  // ---- internals
  private get lines() {
    return this.controller.lines;
  }

  private measure() {
    const W = this.root.clientWidth || 800;
    this.Hv = this.root.clientHeight || 600;
    this.inner.style.width = `${SCREENS * W}px`;
    if (this.cv) {
      // as wide as the viewport, or position:sticky has no room to hold it at the left
      this.cvw!.style.width = `${W}px`;
      const dpr = globalThis.devicePixelRatio || 1,
        h = Math.max(1, this.Hv - AXIS_H);
      this.cv.width = Math.round(W * dpr);
      this.cv.height = Math.round(h * dpr);
      this.cv.style.width = `${W}px`;
      this.cv.style.height = `${h}px`;
    }
    this.controller.setViewport(W, Math.max(1, this.Hv - AXIS_H));
    this.band = [0, -1];
    this.renderRows(true);
    this.apply();
    this.frame();
  }

  private apply() {
    const c = this.controller,
      s = this.inner.style;
    if (c.log) {
      s.setProperty("--o", String(c.N - this.base - c.contentWidth / 2));
      s.setProperty("--k", "1");
      s.setProperty("--n", String(c.N - this.base));
      this.rows.style.backgroundImage = "none";
    } else {
      s.setProperty("--o", String(c.T0 - this.base));
      s.setProperty("--k", String(1 / c.spp));
    }
    const key = `${c.log}|${c.T0}|${c.N}|${c.spp}|${c.W}`;
    if (key === this.axisKey) return;
    this.axisKey = key;
    const ax = c.axis();
    if (ax.step) {
      const px = ax.step / c.spp,
        first = ax.ticks[0]?.x ?? 0;
      this.rows.style.backgroundImage = "linear-gradient(to right,#eee 0 1px,transparent 1px)";
      this.rows.style.backgroundSize = `${px}px 100%`;
      this.rows.style.backgroundPosition = `${first}px 0`;
    }
    this.axis.replaceChildren(
      ...ax.ticks.map((t) => {
        const d = el("div", "rg-tick");
        d.style.left = `${t.x}px`;
        d.textContent = t.label;
        return d;
      }),
    );
  }

  /** one frame: the row band, the canvas */
  private frame() {
    if (this.o.virtual) this.renderRows(false);
    this.draw();
  }

  private schedule() {
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      this.frame();
    });
  }
  /** redraw the canvas now (e.g. every animation frame while controller.dy animates rows) */
  draw() {
    const cv = this.cv;
    if (!cv) return;
    const ctx = cv.getContext("2d")!,
      dpr = globalThis.devicePixelRatio || 1,
      H = this.o.rowHeight,
      c = this.controller,
      W = c.W,
      n = c.o.now(),
      h = this.Hv - AXIS_H,
      [first, last] = c.visibleRows(),
      X = (t: number) => c.x(t);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, h);
    for (let i = first; i <= last; i++) {
      const ln = this.lines[i]!,
        y = c.rowY(i),
        b = ln.bar;
      // the first plan: a faint grey bar under the current one, when it moved
      if (b && !b.planned && b.due0 !== undefined && (b.due0 !== b.due || (b.a0 ?? b.a) !== b.a)) {
        const g0 = Math.max(-2, X(b.a0 ?? b.a)),
          g1 = Math.min(W + 2, X(b.due0));
        if (g1 > 0 && g0 < W) {
          ctx.globalAlpha = 0.16;
          ctx.fillStyle = "#888";
          ctx.fillRect(g0, y + 1, Math.max(2, g1 - g0), H - 2);
        }
      }
      // estimate ticks: moved = full height, confirmed = short, state change = dashed; batch changes in purple
      if (b?.ticks)
        for (const tk of b.ticks) {
          const tx = Math.round(X(tk.t)) + 0.5;
          if (tx < 0 || tx > W) continue;
          ctx.globalAlpha = 0.7;
          ctx.strokeStyle = tk.change ? "#6a1b9a" : "#555";
          ctx.lineWidth = tk.change ? 2 : 1;
          ctx.setLineDash(tk.k === "s" ? [2, 2] : []);
          ctx.beginPath();
          ctx.moveTo(tx, tk.k === "c" ? y + H - 8 : y + 1);
          ctx.lineTo(tx, y + H - 1);
          ctx.stroke();
          ctx.setLineDash([]);
          ctx.lineWidth = 1;
        }
      // waiting: hollow and hatched, no fill, no late red
      if (b && b.wait && b.b === undefined) {
        const w0 = Math.max(-2, X(b.a)),
          w1 = Math.min(W + 2, Math.max(w0 + 2, X(Math.max(n, b.due))));
        if (w1 > 0 && w0 < W) {
          const wc = b.wait.on === "human" ? GANTT_COLORS.human : "#8d6e63";
          ctx.save();
          ctx.beginPath();
          ctx.rect(w0, y + 3, w1 - w0, H - 6);
          ctx.clip();
          ctx.globalAlpha = 0.35;
          ctx.strokeStyle = wc;
          // stripes are fixed to the screen (taku 11-11): the old phase mixed in scrollTop, so they crawled on pan
          for (let hx = w0 - H - (((w0 % 8) + 8) % 8); hx < w1; hx += 8) {
            ctx.moveTo(hx, y + H - 3);
            ctx.lineTo(hx + H, y + 3);
          }
          ctx.stroke();
          ctx.restore();
          ctx.globalAlpha = 0.8;
          ctx.strokeStyle = wc;
          ctx.strokeRect(w0 + 0.5, y + 3.5, w1 - w0 - 1, H - 7);
        }
        continue;
      }
      if (ln.slices?.length) {
        const nl = ln.subLanes || 1,
          sh = (H - 6) / nl;
        ctx.globalAlpha = 0.08;
        ctx.fillStyle = "#888";
        for (const s of ln.segs) {
          const x0 = Math.max(-2, X(s.from)),
            x1 = Math.min(W + 2, X(s.to));
          if (x1 > 0 && x0 < W) ctx.fillRect(x0, y + 3, x1 - x0, H - 6);
        }
        for (const sb of ln.slices)
          for (const s of sb.segs) {
            let x0 = X(s.from),
              x1 = X(s.to);
            if (x1 < 0 || x0 > W) continue;
            x0 = Math.max(-2, x0);
            x1 = Math.min(W + 2, Math.max(x0 + 2, x1));
            ctx.globalAlpha = s.part === "range" ? 0.25 : 0.6;
            ctx.fillStyle = GANTT_COLORS[s.state];
            ctx.fillRect(x0, y + 3 + sb.k * sh + 0.5, x1 - x0, Math.max(1, sh - 1));
          }
        continue;
      }
      for (const s of ln.segs) {
        let x0 = X(s.from),
          x1 = X(s.to);
        if (x1 < 0 || x0 > W) continue;
        x0 = Math.max(-2, x0);
        x1 = Math.min(W + 2, Math.max(x0 + 2, x1));
        const col = c.colorOf(b, s);
        ctx.globalAlpha = s.part === "range" ? 0.13 : 0.32;
        ctx.fillStyle = col;
        ctx.fillRect(x0, y + 3, x1 - x0, H - 6);
        if (s.part === "range") {
          ctx.globalAlpha = 0.5;
          ctx.setLineDash([3, 3]);
          ctx.strokeStyle = col;
          ctx.strokeRect(x0 + 0.5, y + 3.5, x1 - x0 - 1, H - 7);
          ctx.setLineDash([]);
        }
        if (s.part === "core" && ln.bar?.crit) {
          ctx.globalAlpha = 1;
          ctx.strokeStyle = "#d32f2f";
          ctx.lineWidth = 2;
          ctx.strokeRect(x0, y + 3, x1 - x0, H - 6);
          ctx.lineWidth = 1;
        }
      }
      // progress underline: length = progress × bar, colour = ahead / on track / behind against now
      const pace = b && paceOf(b, n);
      if (b && pace) {
        const u0 = X(b.a),
          u1 = X(b.a + b.progress! * Math.max(60, b.due - b.a));
        if (u1 > 0 && u0 < W) {
          ctx.globalAlpha = 1;
          ctx.fillStyle = PACE_COLORS[pace];
          ctx.fillRect(
            Math.max(-2, u0),
            y + H - 4,
            Math.max(2, Math.min(W + 2, u1) - Math.max(-2, u0)),
            3,
          );
        }
      }
      // milestone: a diamond at its end
      if (b?.milestone && !b.undated) {
        const mx = X(b.due),
          r = H / 2 - 4;
        if (mx > -r && mx < W + r) {
          ctx.globalAlpha = 0.9;
          ctx.fillStyle = (b.status && this.o.statuses?.[b.status]?.color) || "#455a64";
          ctx.beginPath();
          ctx.moveTo(mx, y + H / 2 - r);
          ctx.lineTo(mx + r, y + H / 2);
          ctx.lineTo(mx, y + H / 2 + r);
          ctx.lineTo(mx - r, y + H / 2);
          ctx.fill();
        }
      }
    }
    // dependencies: an elbow arrow from each dependency's end to the dependent's start (both rows shown)
    ctx.globalAlpha = 0.55;
    ctx.strokeStyle = "#607d8b";
    ctx.fillStyle = "#607d8b";
    for (let i = 0; i < this.lines.length; i++) {
      const b = this.lines[i]!.bar;
      if (!b?.deps || b.undated) continue;
      for (const d of b.deps) {
        const j = c.indexOf(d),
          db = j === undefined ? undefined : this.lines[j]!.bar;
        if (j === undefined || !db || db.undated) continue;
        if (Math.max(i, j) < first || Math.min(i, j) > last) continue;
        const x0 = X(db.due),
          y0 = c.rowY(j) + H / 2,
          x1 = X(b.a),
          y1 = c.rowY(i) + H / 2,
          xm = Math.max(x0 + 6, Math.min(x1 - 6, x0 + 6));
        ctx.beginPath();
        ctx.moveTo(x0, y0);
        ctx.lineTo(xm, y0);
        ctx.lineTo(xm, y1);
        ctx.lineTo(x1 - 1, y1);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x1 - 5, y1 - 3);
        ctx.lineTo(x1 - 5, y1 + 3);
        ctx.fill();
      }
    }
    // standalone milestones (setMilestones): a dashed line down the chart
    ctx.setLineDash([4, 3]);
    for (const m of c.milestones) {
      const mx = Math.round(X(m.t)) + 0.5;
      if (mx < 0 || mx > W) continue;
      ctx.globalAlpha = 0.8;
      ctx.strokeStyle = (m.status && this.o.statuses?.[m.status]?.color) || "#b26a00";
      ctx.beginPath();
      ctx.moveTo(mx, 0);
      ctx.lineTo(mx, h);
      ctx.stroke();
    }
    ctx.setLineDash([]);
    // focus: the crosshair across the chart at the viewport middle, and a band on the focused row
    const fi = c.focusRow();
    if (fi !== undefined) {
      const fy = c.rowY(fi);
      if (fy + H > 0 && fy < h) {
        ctx.globalAlpha = 0.1;
        ctx.fillStyle = "#1565c0";
        ctx.fillRect(0, fy, W, H);
      }
    }
    if (c.o.crosshair) {
      ctx.globalAlpha = 0.7;
      ctx.fillStyle = "#1565c0";
      ctx.fillRect(0, Math.round(c.H / 2) - 1, W, 2);
    }
    ctx.globalAlpha = 1;
  }

  /** the DOM rows: all of them, or (virtual) the band in view plus a screen of overscan */
  private renderRows(force: boolean) {
    const L = this.o.labels;
    if (!this.lines.length) {
      const e = el("div", "rg-empty");
      e.textContent = L.empty;
      this.rows.replaceChildren(e);
      return;
    }
    const H = this.o.rowHeight,
      total = this.lines.length;
    let a = 0,
      b = total - 1;
    if (this.o.virtual) {
      const st = this.controller.scrollY,
        first = Math.floor((st - this.controller.pad) / H),
        last = Math.ceil((st + this.Hv - this.controller.pad) / H);
      if (!force && first >= this.band[0] && last <= this.band[1]) return;
      const over = Math.ceil(this.Hv / H);
      a = Math.max(0, first - over);
      b = Math.min(total - 1, last + over);
      this.band = [a, b];
      this.rows.style.height = `${this.controller.contentHeight}px`;
    } else {
      if (!force) return;
      this.rows.style.padding = `${this.controller.pad}px 0`;
    }
    const frag = document.createDocumentFragment(),
      nl = el("div", "rg-now");
    nl.title = L.now;
    frag.appendChild(nl);
    for (let i = a; i <= b; i++) {
      const r = this.line(this.lines[i]!);
      if (this.o.virtual) r.style.top = `${this.controller.rowTop(i)}px`;
      frag.appendChild(r);
    }
    this.rows.replaceChildren(frag);
  }

  private line(ln: Line): HTMLElement {
    const L = this.o.labels,
      tz = this.o.tzOffset,
      n = this.controller.o.now();
    if (ln.blank) return el("div", "rg-r rg-blank");
    if (ln.lane !== undefined) {
      const r = el("div", "rg-r rg-lane"),
        nm = el("span", "rg-name");
      nm.textContent = ln.lane;
      r.appendChild(nm);
      return r;
    }
    const b = ln.bar!,
      row = el("div", "rg-r"),
      st = stateOf(b),
      end = endOf(b, n),
      waiting = !!b.wait && b.b === undefined,
      late = !waiting && !b.planned && !b.stale && b.b === undefined && n > b.due;
    // a tap (not a drag) focuses the row: it scrolls under the crosshair
    let down: { x: number; y: number } | undefined;
    row.onpointerdown = (e) => (down = { x: e.clientX, y: e.clientY });
    row.onclick = (e) => {
      if (down && Math.hypot(e.clientX - down.x, e.clientY - down.y) > 6) return;
      this.controller.setFocus(b);
    };
    row.title = `${b.name ?? b.id}  ${b.id}\n${fmt(startOf(b), tz)} → ${fmt(end, tz)}${b.planned && b.lo !== undefined ? ` (${fmt(b.lo, tz)}–${fmt(b.due, tz)})` : ""}\n${L.states[late ? "late" : st] ?? st}${b.blocked ? ` · ❗${L.blocked}` : ""}${waiting && b.wait!.why ? `\n${b.wait!.why}` : ""}${b.confirmed && b.b === undefined ? `\n${L.confirmed.replace("{d}", dur(n - b.confirmed))}` : ""}${b.what ? `\n${b.what}` : ""}`;
    if (!this.o.canvas)
      for (const s of ln.segs) {
        const seg = el(
            "div",
            `rg-seg rg-${s.part}${b.crit && s.part === "core" ? " rg-crit" : ""}`,
          ),
          c = GANTT_COLORS[s.state];
        seg.style.cssText = `--a:${s.from - this.base};--d:${Math.max(0, s.to - s.from)};background-color:${c};color:${c}`;
        row.appendChild(seg);
      }
    const nm = el("span", "rg-name");
    if (ln.depth) nm.style.paddingLeft = `${14 + ln.depth * 14}px`;
    if (ln.hasKids) {
      const f = el("button", "rg-fold");
      f.textContent = ln.folded ? "▸" : "▾";
      f.title = ln.folded ? L.unfold : L.fold;
      f.onclick = (e) => {
        e.stopPropagation();
        this.toggle(b.lane, b.id);
      };
      nm.appendChild(f);
    }
    // "name: description" (taku 11-11): the name bold; the description follows as far as there is room, on phones
    // too («能顕示多少就顕示多少»), cut with … at the edge
    nm.append((b.blocked ? "❗" : "") + (ln.otherLane ? `[${ln.otherLane}] ` : ""));
    const nb = document.createElement("b");
    nb.textContent = b.name ?? b.id;
    nm.appendChild(nb);
    if (b.what && b.name && b.what !== b.name) {
      const d = el("span", "rg-desc");
      d.textContent = `: ${b.what.replace(/\s+/g, " ")}`;
      nm.appendChild(d);
    }
    const grp = (b as GanttRow & { group?: { n: number; open: number } }).group;
    if (grp) {
      const c = document.createElement("i");
      c.className = "rg-count";
      c.textContent = `${grp.open}/${grp.n}`;
      nm.appendChild(c);
    }
    const sst = b.status ? this.o.statuses?.[b.status] : undefined,
      badge = late ? "late" : st === "verified" || st === "open" || st === "planned" ? "" : st;
    if (sst && sst.badge !== false && !late) {
      const i = document.createElement("i");
      i.style.background = sst.color;
      i.textContent = sst.label;
      nm.appendChild(i);
    } else if (badge && !b.undated) {
      const i = document.createElement("i");
      i.style.background = GANTT_COLORS[badge as keyof typeof GANTT_COLORS] ?? "#999";
      i.textContent = late
        ? `${L.states.late ?? "late"} ${dur(b.due - n)}`
        : (L.states[badge] ?? badge);
      nm.appendChild(i);
    }
    if (waiting) {
      const i = document.createElement("i");
      i.className = "rg-wait";
      i.textContent = L.wait.replace("{d}", dur(n - b.wait!.t));
      nm.appendChild(i);
    }
    row.appendChild(nm);
    if (this.onOpen) {
      const sp = el("span", "rg-sp"),
        op = el("button", "rg-open");
      op.textContent = "⋯";
      op.title = L.open;
      op.onclick = (e) => {
        e.stopPropagation();
        this.controller.open(b);
      };
      row.append(sp, op);
    }
    return row;
  }
}

function el(tag: string, cls: string) {
  const e = document.createElement(tag) as HTMLDivElement;
  e.className = cls;
  return e;
}

function fmt(t: number, tz: number) {
  const d = new Date((t + tz) * 1000),
    p = (x: number) => String(x).padStart(2, "0");
  return `${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}
