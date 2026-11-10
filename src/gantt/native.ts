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
  type GanttBar,
  type GanttSegment,
  type GanttView,
  MAX_SPP,
  MIN_SPP,
  endOf,
  fitView,
  groupRows,
  segmentsOf,
  dur,
  paceOf,
  PACE_COLORS,
  startOf,
  stateOf,
  tickLabel,
  tickStep,
  ticks,
} from "./model";

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
  /** a ⋯ button at the right end of each row calls this (the page opens its dialog) */
  onOpen?: (bar: GanttRow) => void;
};

/** a bar may carry extra display flags */
export type GanttRow = GanttBar & { blocked?: boolean; what?: string };

const ZH: Required<GanttLabels> = {
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

const SCREENS = 7;
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
.rg-gantt .rg-empty{padding:20px;color:#888}
`;

type Line = { lane?: string; bar?: GanttRow; segs: GanttSegment[] };

export class GanttChart {
  readonly root: HTMLDivElement;
  private inner: HTMLDivElement;
  private axis: HTMLDivElement;
  private rows: HTMLDivElement;
  private cvw?: HTMLDivElement;
  private cv?: HTMLCanvasElement;
  private bars: GanttRow[] = [];
  private lines: Line[] = [];
  private T0 = 0;
  private spp = 60;
  private base = 0;
  private W = 800;
  private Hv = 600;
  private lo = 0;
  private hi = 0;
  private fitted = false;
  private o: {
    rowHeight: number;
    tzOffset: number;
    now: () => number;
    labels: Required<GanttLabels>;
    virtual: boolean;
    canvas: boolean;
    freePan: boolean;
  };
  private raf = 0;
  private onOpen?: (bar: GanttRow) => void;
  private ro?: ResizeObserver;
  private axisKey = "";
  private band: [number, number] = [0, -1];

  constructor(host: HTMLElement, opts: GanttOptions = {}) {
    this.o = {
      rowHeight: opts.rowHeight ?? 26,
      tzOffset: opts.tzOffset ?? 32400,
      now: opts.now ?? (() => Date.now() / 1000),
      labels: {
        ...ZH,
        ...opts.labels,
        states: { ...ZH.states, ...opts.labels?.states },
      } as Required<GanttLabels>,
      virtual: opts.virtual ?? true,
      canvas: opts.canvas ?? true,
      freePan: opts.freePan ?? true,
    };
    this.onOpen = opts.onOpen;
    if (!document.getElementById("rg-gantt-css")) {
      const s = document.createElement("style");
      s.id = "rg-gantt-css";
      s.textContent = CSS;
      document.head.appendChild(s);
    }
    this.root = el("div", "rg-gantt");
    if (this.o.virtual) this.root.classList.add("rg-virt");
    if (this.o.freePan) this.root.classList.add("rg-free");
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
    this.base = Math.round(this.o.now());
    this.measure();
    this.input();
    if (typeof ResizeObserver !== "undefined") {
      this.ro = new ResizeObserver(() => {
        const w = this.root.clientWidth,
          h = this.root.clientHeight;
        if (!w || (w === this.W && h === this.Hv)) return;
        const v = this.view;
        this.measure();
        this.setView(v);
      });
      this.ro.observe(this.root);
    }
  }

  setBars(bars: GanttRow[]) {
    const v = this.view;
    this.bars = bars;
    const n = this.o.now();
    this.lo = Math.min(n, ...bars.map(startOf));
    this.hi = Math.max(n, ...bars.map((b) => endOf(b, n)));
    this.relines();
    this.inner.style.setProperty("--n", String(n - this.base));
    this.band = [0, -1];
    this.renderRows(true);
    if (!this.fitted && bars.length) {
      this.fitted = true;
      const spp = Math.min(86400 / this.W, fitView(this.lo, this.hi, this.W).spp);
      this.setView({ t0: n - (this.W / 2) * spp, spp });
    } else this.setView(v);
  }

  /** fold or unfold a row's sub-tasks (rows whose id starts with "<id>/", same lane) */
  toggle(lane: string, id: string) {
    const k = `${lane} ${id}`;
    if (this.folded.has(k)) this.folded.delete(k);
    else this.folded.add(k);
    this.relines();
    this.band = [0, -1];
    this.renderRows(true);
    this.draw();
  }

  private folded = new Set<string>();
  private kids = new Set<string>();
  private relines() {
    const n = this.o.now();
    this.lines = [];
    this.kids = new Set();
    for (const g of groupRows(this.bars)) {
      const ids = g.bars.map((b) => b.id);
      for (const id of ids)
        for (const o of ids) if (o.startsWith(`${id}/`)) this.kids.add(`${g.lane} ${id}`);
      this.lines.push({ lane: g.lane, segs: [] });
      for (const b of g.bars as GanttRow[]) {
        const hidden = [...this.folded].some(
          (f) => f.startsWith(`${g.lane} `) && b.id.startsWith(`${f.slice(g.lane.length + 1)}/`),
        );
        if (!hidden) this.lines.push({ bar: b, segs: segmentsOf(b, n) });
      }
    }
  }

  fit() {
    this.setView(fitView(this.lo, this.hi, this.W));
  }

  today() {
    this.setView({ t0: this.o.now() - (this.W / 2) * this.spp, spp: this.spp });
  }

  get view(): GanttView {
    return { t0: this.T0 + this.root.scrollLeft * this.spp, spp: this.spp };
  }

  setView(v: GanttView) {
    this.spp = Math.min(MAX_SPP, Math.max(MIN_SPP, v.spp));
    const mid = ((SCREENS - 1) / 2) * this.W;
    this.T0 = v.t0 - mid * this.spp;
    this.apply();
    this.root.scrollLeft = mid;
    this.frame();
  }

  destroy() {
    this.ro?.disconnect();
    cancelAnimationFrame(this.raf);
    this.root.remove();
  }

  // ---- internals

  private measure() {
    this.W = this.root.clientWidth || 800;
    this.Hv = this.root.clientHeight || 600;
    this.inner.style.width = `${SCREENS * this.W}px`;
    if (this.cv) {
      // as wide as the viewport, or position:sticky has no room to hold it at the left
      this.cvw!.style.width = `${this.W}px`;
      const dpr = globalThis.devicePixelRatio || 1,
        h = Math.max(1, this.Hv - AXIS_H);
      this.cv.width = Math.round(this.W * dpr);
      this.cv.height = Math.round(h * dpr);
      this.cv.style.width = `${this.W}px`;
      this.cv.style.height = `${h}px`;
    }
  }

  private apply() {
    const s = this.inner.style;
    s.setProperty("--o", String(this.T0 - this.base));
    s.setProperty("--k", String(1 / this.spp));
    const step = tickStep(this.spp),
      tz = this.o.tzOffset,
      first = Math.ceil((this.T0 + tz) / step) * step - tz,
      px = step / this.spp;
    this.rows.style.backgroundImage = "linear-gradient(to right,#eee 0 1px,transparent 1px)";
    this.rows.style.backgroundSize = `${px}px 100%`;
    this.rows.style.backgroundPosition = `${(first - this.T0) / this.spp}px 0`;
    const key = `${this.T0}|${this.spp}`;
    if (key === this.axisKey) return;
    this.axisKey = key;
    const ts = ticks(this.T0, this.T0 + SCREENS * this.W * this.spp, step, tz);
    this.axis.replaceChildren(
      ...ts.map((t) => {
        const d = el("div", "rg-tick");
        d.style.left = `${(t - this.T0) / this.spp}px`;
        d.textContent = tickLabel(t, step, tz);
        return d;
      }),
    );
  }

  /** one scroll/zoom frame: edges, the row band, the canvas */
  private frame() {
    this.edges();
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

  private zoomAt(x: number, k: number) {
    const sl = this.root.scrollLeft,
      t = this.T0 + (sl + x) * this.spp,
      spp = Math.min(MAX_SPP, Math.max(MIN_SPP, this.spp / k));
    if (spp === this.spp) return;
    this.spp = spp;
    this.T0 = t - (sl + x) * spp;
    this.apply();
    this.schedule();
  }

  private edges() {
    const sl = this.root.scrollLeft,
      W = this.W,
      mid = ((SCREENS - 1) / 2) * W,
      t0 = this.T0 + sl * this.spp,
      t1 = t0 + W * this.spp,
      room = W * this.spp;
    if ((sl < W && t0 > this.lo - room) || (sl > (SCREENS - 2) * W && t1 < this.hi + room)) {
      const dx = sl - mid;
      this.T0 += dx * this.spp;
      this.apply();
      this.root.scrollLeft -= dx;
    }
  }

  private draw() {
    const cv = this.cv;
    if (!cv) return;
    const ctx = cv.getContext("2d")!,
      dpr = globalThis.devicePixelRatio || 1,
      H = this.o.rowHeight,
      st = this.root.scrollTop,
      t0 = this.T0 + this.root.scrollLeft * this.spp,
      k = 1 / this.spp,
      W = this.W,
      n = this.o.now(),
      h = this.Hv - AXIS_H,
      first = Math.max(0, Math.floor(st / H)),
      last = Math.min(this.lines.length - 1, Math.ceil((st + h) / H));
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, h);
    for (let i = first; i <= last; i++) {
      const ln = this.lines[i]!,
        y = i * H - st,
        b = ln.bar,
        X = (t: number) => (t - t0) * k;
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
      // waiting: hollow and hatched, no fill, no late red
      if (b && b.wait && b.b === undefined) {
        const w0 = Math.max(-2, X(b.a)),
          w1 = Math.min(W + 2, Math.max(w0 + 2, X(Math.max(n, b.due))));
        if (w1 > 0 && w0 < W) {
          const c = b.wait.on === "human" ? GANTT_COLORS.human : "#8d6e63";
          ctx.save();
          ctx.beginPath();
          ctx.rect(w0, y + 3, w1 - w0, H - 6);
          ctx.clip();
          ctx.globalAlpha = 0.35;
          ctx.strokeStyle = c;
          for (let hx = w0 - H - ((w0 + st) % 8); hx < w1; hx += 8) {
            ctx.moveTo(hx, y + H - 3);
            ctx.lineTo(hx + H, y + 3);
          }
          ctx.stroke();
          ctx.restore();
          ctx.globalAlpha = 0.8;
          ctx.strokeStyle = c;
          ctx.strokeRect(w0 + 0.5, y + 3.5, w1 - w0 - 1, H - 7);
        }
        continue;
      }
      for (const s of ln.segs) {
        let x0 = (s.from - t0) * k,
          x1 = (s.to - t0) * k;
        if (x1 < 0 || x0 > W) continue;
        x0 = Math.max(-2, x0);
        x1 = Math.min(W + 2, Math.max(x0 + 2, x1));
        const c = GANTT_COLORS[s.state];
        ctx.globalAlpha = s.part === "range" ? 0.13 : 0.32;
        ctx.fillStyle = c;
        ctx.fillRect(x0, y + 3, x1 - x0, H - 6);
        if (s.part === "range") {
          ctx.globalAlpha = 0.5;
          ctx.setLineDash([3, 3]);
          ctx.strokeStyle = c;
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
      const st = this.root.scrollTop,
        first = Math.floor(st / H),
        last = Math.ceil((st + this.Hv) / H);
      if (!force && first >= this.band[0] && last <= this.band[1]) return;
      const over = Math.ceil(this.Hv / H);
      a = Math.max(0, first - over);
      b = Math.min(total - 1, last + over);
      this.band = [a, b];
      this.rows.style.height = `${total * H}px`;
    } else if (!force) return;
    const frag = document.createDocumentFragment(),
      nl = el("div", "rg-now");
    nl.title = L.now;
    frag.appendChild(nl);
    for (let i = a; i <= b; i++) {
      const r = this.line(this.lines[i]!);
      if (this.o.virtual) r.style.top = `${i * H}px`;
      frag.appendChild(r);
    }
    this.rows.replaceChildren(frag);
  }

  private line(ln: Line): HTMLElement {
    const L = this.o.labels,
      tz = this.o.tzOffset,
      n = this.o.now();
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
    const nm = el("span", "rg-name"),
      fk = `${b.lane} ${b.id}`;
    if (this.kids.has(fk)) {
      const f = el("button", "rg-fold");
      f.textContent = this.folded.has(fk) ? "▸" : "▾";
      f.title = this.folded.has(fk) ? L.unfold : L.fold;
      f.onclick = (e) => {
        e.stopPropagation();
        this.toggle(b.lane, b.id);
      };
      nm.appendChild(f);
    }
    nm.append((b.blocked ? "❗" : "") + (b.name ?? b.id));
    const badge = late ? "late" : st === "verified" || st === "open" || st === "planned" ? "" : st;
    if (badge) {
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
        this.onOpen?.(b);
      };
      row.append(sp, op);
    }
    return row;
  }

  private input() {
    const r = this.root;
    r.addEventListener("scroll", () => this.schedule(), { passive: true });
    r.addEventListener(
      "wheel",
      (e) => {
        if (!e.ctrlKey && !e.metaKey) return;
        e.preventDefault();
        this.zoomAt(e.clientX - this.left(), Math.exp(-e.deltaY * 0.01));
      },
      { passive: false },
    );
    let g = 1;
    r.addEventListener("gesturestart", (e: any) => {
      e.preventDefault();
      g = 1;
    });
    r.addEventListener("gesturechange", (e: any) => {
      e.preventDefault();
      this.zoomAt(e.clientX - this.left(), e.scale / g);
      g = e.scale;
    });
    // touch: pinch always; with freePan also one-finger 2D pan + momentum
    let pinch: { d: number; left: number } | undefined,
      pan: { x: number; y: number; t: number; vx: number; vy: number } | undefined,
      fling = 0;
    const two = (e: TouchEvent) => {
      const a = e.touches[0]!,
        b = e.touches[1]!;
      return { x: (a.clientX + b.clientX) / 2, d: Math.abs(a.clientX - b.clientX) };
    };
    r.addEventListener(
      "touchstart",
      (e) => {
        cancelAnimationFrame(fling);
        if (e.touches.length === 2) {
          pinch = { d: two(e).d, left: this.left() };
          pan = undefined;
        } else if (e.touches.length === 1 && this.o.freePan) {
          const t = e.touches[0]!;
          pan = { x: t.clientX, y: t.clientY, t: performance.now(), vx: 0, vy: 0 };
        }
      },
      { passive: true },
    );
    r.addEventListener(
      "touchmove",
      (e) => {
        if (pinch && e.touches.length === 2) {
          const c = two(e);
          if (pinch.d > 10 && c.d > 10) this.zoomAt(c.x - pinch.left, c.d / pinch.d);
          pinch.d = c.d;
          return;
        }
        if (!pan || e.touches.length !== 1) return;
        const t = e.touches[0]!,
          now = performance.now(),
          dx = t.clientX - pan.x,
          dy = t.clientY - pan.y,
          dt = Math.max(1, now - pan.t);
        r.scrollLeft -= dx;
        r.scrollTop -= dy;
        pan = {
          x: t.clientX,
          y: t.clientY,
          t: now,
          vx: (0.8 * dx) / dt + 0.2 * pan.vx,
          vy: (0.8 * dy) / dt + 0.2 * pan.vy,
        };
      },
      { passive: true },
    );
    r.addEventListener(
      "touchend",
      (e) => {
        if (e.touches.length < 2) pinch = undefined;
        if (!pan || e.touches.length) return;
        let { vx, vy } = pan,
          last = performance.now();
        pan = undefined;
        const step = (now: number) => {
          const dt = now - last;
          last = now;
          r.scrollLeft -= vx * dt;
          r.scrollTop -= vy * dt;
          const f = Math.pow(0.995, dt);
          vx *= f;
          vy *= f;
          if (Math.hypot(vx, vy) > 0.02) fling = requestAnimationFrame(step);
        };
        fling = requestAnimationFrame(step);
      },
      { passive: true },
    );
    // mouse drag pans both axes
    let drag: { x: number; y: number } | undefined;
    r.addEventListener("pointerdown", (e) => {
      if (e.pointerType !== "mouse" || e.button !== 0) return;
      drag = { x: e.clientX, y: e.clientY };
    });
    window.addEventListener("pointermove", (e) => {
      if (!drag) return;
      r.scrollLeft -= e.clientX - drag.x;
      r.scrollTop -= e.clientY - drag.y;
      drag = { x: e.clientX, y: e.clientY };
    });
    window.addEventListener("pointerup", () => (drag = undefined));
  }

  private leftCache = { at: -1e9, v: 0 };
  private left() {
    const t = performance.now();
    if (t - this.leftCache.at > 500)
      this.leftCache = { at: t, v: this.root.getBoundingClientRect().left };
    return this.leftCache.v;
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
