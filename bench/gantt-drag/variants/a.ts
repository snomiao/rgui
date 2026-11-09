/**
 * rgui gantt — DOM view. Fills its host; vertical scroll is native, the time
 * axis pans forever both ways (wheel / drag / one-finger swipe) and zooms with
 * ctrl+wheel, trackpad pinch or a two-finger pinch. Each row's name is pinned
 * to the left edge of the visible area; bars are a see-through band under it.
 */
import {
  GANTT_COLORS,
  type GanttBar,
  type GanttView,
  endOf,
  fitView,
  groupRows,
  panBy,
  segmentsOf,
  startOf,
  stateOf,
  tickLabel,
  tickStep,
  ticks,
  toX,
  zoomAt,
} from "../../../src/gantt/model";

export * from "../../../src/gantt/model";

export type GanttLabels = {
  /** state → people-facing word (tooltips / legend) */
  states?: Partial<Record<string, string>>;
  now?: string;
  blocked?: string;
  empty?: string;
};

export type GanttOptions = {
  rowHeight?: number;
  tzOffset?: number;
  labels?: GanttLabels;
  /** clock in epoch seconds (tests) */
  now?: () => number;
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
};

const CSS = `
.rg-gantt{position:relative;width:100%;height:100%;overflow:hidden;font:13px system-ui,sans-serif;color:#222;background:#fff;user-select:none;-webkit-user-select:none}
.rg-gantt .rg-axis{position:absolute;left:0;right:0;top:0;height:24px;background:#f4f3ee;border-bottom:1px solid #ddd;z-index:3;overflow:hidden}
.rg-gantt .rg-tick{position:absolute;top:5px;font-size:11px;color:#666;transform:translateX(-50%);white-space:nowrap}
.rg-gantt .rg-scroll{position:absolute;left:0;right:0;top:24px;bottom:0;overflow-x:hidden;overflow-y:auto;touch-action:pan-y}
.rg-gantt .rg-body{position:relative;overflow:hidden}
.rg-gantt .rg-grid{position:absolute;top:0;bottom:0;width:1px;background:#eee}
.rg-gantt .rg-now{position:absolute;top:0;bottom:0;width:2px;background:#d32f2f;opacity:.7;z-index:2}
.rg-gantt .rg-lane{position:absolute;left:0;right:0;font-weight:600;background:#fafafa;border-top:1px solid #e5e5e5;padding-left:6px;box-sizing:border-box;z-index:1}
.rg-gantt .rg-seg{position:absolute;border-radius:3px;box-sizing:border-box}
.rg-gantt .rg-core{opacity:.32}
.rg-gantt .rg-range{opacity:.13;border:1px dashed currentColor}
.rg-gantt .rg-late{opacity:.32;background-image:repeating-linear-gradient(45deg,transparent 0 4px,rgba(255,255,255,.6) 4px 8px)}
.rg-gantt .rg-crit{outline:2px solid #d32f2f}
.rg-gantt .rg-name{position:absolute;left:0;padding-left:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%;z-index:1;pointer-events:none;text-shadow:0 0 3px #fff,0 0 3px #fff}
.rg-gantt .rg-name i{font-style:normal;font-size:11px;margin-left:6px;padding:0 4px;border-radius:3px;color:#fff}
.rg-gantt .rg-row{position:absolute;left:0;right:0}
.rg-gantt .rg-empty{padding:20px;color:#888}
`;

export class GanttChart {
  readonly root: HTMLDivElement;
  private axis: HTMLDivElement;
  private scroll: HTMLDivElement;
  private body: HTMLDivElement;
  private bars: GanttRow[] = [];
  private v: GanttView = { t0: 0, spp: 60 };
  private fitted = false;
  private o: Required<Omit<GanttOptions, "labels">> & { labels: Required<GanttLabels> };
  private raf = 0;
  private ro?: ResizeObserver;
  private onWheel: (e: WheelEvent) => void;

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
    };
    if (!document.getElementById("rg-gantt-css")) {
      const s = document.createElement("style");
      s.id = "rg-gantt-css";
      s.textContent = CSS;
      document.head.appendChild(s);
    }
    this.root = el("div", "rg-gantt");
    this.axis = el("div", "rg-axis");
    this.scroll = el("div", "rg-scroll");
    this.body = el("div", "rg-body");
    this.scroll.appendChild(this.body);
    this.root.append(this.axis, this.scroll);
    host.appendChild(this.root);

    this.onWheel = (e) => {
      const r = this.root.getBoundingClientRect(),
        x = e.clientX - r.left;
      if (e.ctrlKey || e.metaKey) {
        // ctrl+wheel, or a trackpad pinch (browsers send it as ctrl+wheel)
        e.preventDefault();
        this.setView(zoomAt(this.v, x, Math.exp(-e.deltaY * 0.01)));
      } else if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
        e.preventDefault();
        this.setView(panBy(this.v, e.shiftKey ? e.deltaY || e.deltaX : e.deltaX));
      }
    };
    this.root.addEventListener("wheel", this.onWheel, { passive: false });
    this.pointers();
    if (typeof ResizeObserver !== "undefined") {
      this.ro = new ResizeObserver(() => this.schedule());
      this.ro.observe(this.root);
    }
  }

  /** replace the data; the first non-empty set fits the view (later sets keep the user's pan/zoom) */
  setBars(bars: GanttRow[]) {
    this.bars = bars;
    if (!this.fitted && bars.length) {
      // first view: now in the middle, at most a day across (fit() shows everything)
      const W = this.root.clientWidth || 800;
      this.fit();
      const spp = Math.min(86400 / W, this.v.spp);
      this.setView({ t0: this.o.now() - (W / 2) * spp, spp });
      this.fitted = true;
    } else this.schedule();
  }

  /** show every bar (and now) */
  fit() {
    const n = this.o.now(),
      lo = Math.min(n, ...this.bars.map(startOf)),
      hi = Math.max(n, ...this.bars.map((b) => endOf(b, n)));
    this.setView(fitView(lo, hi, this.root.clientWidth || 800));
  }

  /** keep the zoom, put now in the middle */
  today() {
    const w = this.root.clientWidth || 800;
    this.setView({ t0: this.o.now() - (w / 2) * this.v.spp, spp: this.v.spp });
  }

  get view(): GanttView {
    return this.v;
  }

  setView(v: GanttView) {
    this.v = this.clamp(v);
    this.schedule();
  }

  /**
   * endless both ways, but never lost: at least a quarter of the width keeps
   * some of the data (every bar and now) in view
   */
  private clamp(v: GanttView): GanttView {
    if (!this.bars.length) return v;
    const W = this.root.clientWidth || 800,
      n = this.o.now(),
      seen = this.onScreen(),
      lo = Math.min(n, ...seen.map(startOf)),
      hi = Math.max(n, ...seen.map((b) => endOf(b, n))),
      keep = (W / 4) * v.spp,
      t0 = Math.min(hi - keep, Math.max(lo + keep - W * v.spp, v.t0));
    return t0 === v.t0 ? v : { t0, spp: v.spp };
  }

  /** the bars in the rows scrolled into view (pan/zoom stay near what you are looking at) */
  private onScreen(): GanttBar[] {
    const H = this.o.rowHeight,
      top = this.scroll.scrollTop,
      bottom = top + (this.scroll.clientHeight || 600),
      out: GanttBar[] = [];
    let y = 0;
    for (const g of groupRows(this.bars)) {
      y += H;
      for (const b of g.bars) {
        if (y + H > top && y < bottom) out.push(b);
        y += H;
      }
    }
    return out;
  }

  destroy() {
    this.ro?.disconnect();
    cancelAnimationFrame(this.raf);
    this.root.remove();
  }

  private schedule() {
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      this.render();
    });
  }

  private pointers() {
    const pts = new Map<number, number>(); // pointerId → clientX
    let last: { x: number; d: number } | undefined;
    const centre = () => {
      const xs = [...pts.values()],
        r = this.root.getBoundingClientRect();
      return {
        x: xs.reduce((s, z) => s + z, 0) / xs.length - r.left,
        d: xs.length > 1 ? Math.abs(xs[0]! - xs[1]!) : 0,
      };
    };
    this.scroll.addEventListener("pointerdown", (e) => {
      if (e.pointerType === "mouse" && e.button !== 0) return;
      pts.set(e.pointerId, e.clientX);
      last = centre();
    });
    this.scroll.addEventListener("pointermove", (e) => {
      if (!pts.has(e.pointerId) || !last) return;
      pts.set(e.pointerId, e.clientX);
      const c = centre();
      let v = panBy(this.v, last.x - c.x);
      if (pts.size > 1 && last.d > 10 && c.d > 10) v = zoomAt(v, c.x, c.d / last.d);
      last = c;
      this.setView(v);
    });
    const up = (e: PointerEvent) => {
      pts.delete(e.pointerId);
      last = pts.size ? centre() : undefined;
    };
    this.scroll.addEventListener("pointerup", up);
    this.scroll.addEventListener("pointercancel", up);
    // Safari trackpad pinch
    let g = 1;
    this.root.addEventListener("gesturestart", (e: any) => {
      e.preventDefault();
      g = 1;
    });
    this.root.addEventListener("gesturechange", (e: any) => {
      e.preventDefault();
      const r = this.root.getBoundingClientRect();
      this.setView(zoomAt(this.v, e.clientX - r.left, e.scale / g));
      g = e.scale;
    });
  }

  private render() {
    const W = this.root.clientWidth || 800,
      H = this.o.rowHeight,
      n = this.o.now(),
      v = this.v,
      L = this.o.labels,
      tFrom = v.t0,
      tTo = v.t0 + W * v.spp;
    // axis
    const step = tickStep(v.spp),
      ts = ticks(tFrom, tTo, step, this.o.tzOffset);
    this.axis.replaceChildren(
      ...ts.map((t) => {
        const d = el("div", "rg-tick");
        d.style.left = `${toX(v, t)}px`;
        d.textContent = tickLabel(t, step, this.o.tzOffset);
        return d;
      }),
    );
    if (!this.bars.length) {
      const e = el("div", "rg-empty");
      e.textContent = L.empty;
      this.body.replaceChildren(e);
      return;
    }
    const out: HTMLElement[] = [];
    let y = 0;
    for (const g of groupRows(this.bars)) {
      const ln = el("div", "rg-lane");
      ln.style.cssText = `top:${y}px;height:${H}px;line-height:${H}px`;
      ln.textContent = g.lane;
      out.push(ln);
      y += H;
      for (const b of g.bars as GanttRow[]) {
        const row = el("div", "rg-row");
        row.style.cssText = `top:${y}px;height:${H}px`;
        const st = stateOf(b),
          end = endOf(b, n),
          late = !b.planned && !b.stale && b.b === undefined && n > b.due;
        row.title = `${b.name ?? b.id}  ${b.id}\n${fmt(startOf(b), this.o.tzOffset)} → ${fmt(end, this.o.tzOffset)}${b.planned && b.lo !== undefined ? ` (${fmt(b.lo, this.o.tzOffset)}–${fmt(b.due, this.o.tzOffset)})` : ""}\n${L.states[late ? "late" : st] ?? st}${b.blocked ? ` · ❗${L.blocked}` : ""}${b.what ? `\n${b.what}` : ""}`;
        for (const s of segmentsOf(b, n)) {
          const x0 = toX(v, s.from),
            x1 = toX(v, s.to);
          if (x1 < -2 || x0 > W + 2) continue;
          const seg = el(
              "div",
              `rg-seg rg-${s.part}${b.crit && s.part === "core" ? " rg-crit" : ""}`,
            ),
            c = GANTT_COLORS[s.state];
          // clamp far-off ends so huge zoom levels keep sane pixel sizes
          const a = Math.max(-10, x0),
            z = Math.min(W + 10, x1);
          seg.style.cssText = `left:${a}px;width:${Math.max(2, z - a)}px;top:3px;bottom:3px;background-color:${c};color:${c}`;
          row.appendChild(seg);
        }
        const nm = el("div", "rg-name");
        nm.style.cssText = `top:0;height:${H}px;line-height:${H}px`;
        nm.textContent = (b.blocked ? "❗" : "") + (b.name ?? b.id);
        const badge = late
          ? "late"
          : st === "verified" || st === "open" || st === "planned"
            ? ""
            : st;
        if (badge) {
          const i = document.createElement("i");
          i.style.background = GANTT_COLORS[badge as keyof typeof GANTT_COLORS] ?? "#999";
          i.textContent = L.states[badge] ?? badge;
          nm.appendChild(i);
        }
        row.appendChild(nm);
        out.push(row);
        y += H;
      }
    }
    for (const t of ts) {
      const gl = el("div", "rg-grid");
      gl.style.left = `${toX(v, t)}px`;
      out.unshift(gl);
    }
    const nx = toX(v, n);
    if (nx >= 0 && nx <= W) {
      const nl = el("div", "rg-now");
      nl.style.left = `${nx}px`;
      nl.title = L.now;
      out.push(nl);
    }
    this.body.style.height = `${y}px`;
    this.body.replaceChildren(...out);
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
