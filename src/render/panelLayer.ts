/**
 * rgui panels — screen-anchored palette/panel primitive drawn on the canvas.
 *
 * Panels are viewport chrome (constant screen size, never zoom), stacked at
 * an edge or placed at an explicit screen position. Items support
 * click-to-add and drag-onto-canvas (the host receives world coordinates
 * and creates whatever the item stands for).
 */
import type { ViewTransform } from "../core/grid.js";
import { DARK_THEME, type RgTheme } from "../core/theme.js";
import {
  subtractIntervals,
  type Interval,
  type SideCoverage,
} from "../core/pack.js";

/** active theme for this draw pass (set by the exported draw entry points) */
let T: RgTheme = DARK_THEME;

export interface PanelItem {
  id: string;
  label: string;
  /** row dot color (e.g. a signal-kind color); default gray */
  color?: string;
}

export interface Panel {
  id: string;
  title: string;
  /** stacking edge, or an explicit screen position */
  anchor?: "left" | "right" | { x: number; y: number };
  /** panel width in px (default 180) */
  w?: number;
  items: PanelItem[];
  collapsed?: boolean;
  /** item clicked (no drag) — e.g. add at viewport center */
  onItemClick?: (item: PanelItem, screen: { x: number; y: number }) => void;
  /** item dragged onto the canvas and released */
  onItemDrop?: (
    item: PanelItem,
    at: { world: { x: number; y: number }; screen: { x: number; y: number } },
  ) => void;
}

export const PANEL = {
  headerH: 24,
  rowH: 22,
  pad: 8,
  gap: 12,
  margin: 12,
  defaultW: 180,
};

export interface PanelRect {
  panel: Panel;
  x: number;
  y: number;
  w: number;
  h: number;
  /** y of first item row (absolute screen px) */
  itemsY: number;
}

/** screen rects for all panels (stacked per edge, explicit anchors as-is) */
export function panelLayout(
  panels: Panel[],
  size: { width: number; height: number },
): PanelRect[] {
  const out: PanelRect[] = [];
  const stackY: Record<"left" | "right", number> = {
    left: PANEL.margin,
    right: PANEL.margin,
  };
  for (const p of panels) {
    const w = p.w ?? PANEL.defaultW;
    const h =
      PANEL.headerH +
      (p.collapsed ? 0 : PANEL.pad + p.items.length * PANEL.rowH + PANEL.pad);
    let x: number;
    let y: number;
    const anchor = p.anchor ?? "left";
    if (typeof anchor === "object") {
      x = anchor.x;
      y = anchor.y;
    } else {
      x = anchor === "left" ? PANEL.margin : size.width - PANEL.margin - w;
      y = stackY[anchor];
      stackY[anchor] += h + PANEL.gap;
    }
    out.push({ panel: p, x, y, w, h, itemsY: y + PANEL.headerH + PANEL.pad });
  }
  return out;
}

/**
 * Flush contact between panel rects: shared edge segments, per panel and
 * side. Fused boundaries dissolve exactly like snapped nodes (辺界消融) —
 * the shared border is not drawn and the touching corners square off, so
 * a snapped pair reads as one continuous card.
 */
export function panelCoverage(rects: PanelRect[]): Map<string, SideCoverage> {
  const EPS = 0.5;
  const cov = new Map<string, SideCoverage>();
  const get = (id: string) => {
    let c = cov.get(id);
    if (!c) cov.set(id, (c = { top: [], right: [], bottom: [], left: [] }));
    return c;
  };
  for (const a of rects) {
    for (const b of rects) {
      if (a === b) continue;
      if (Math.abs(a.x + a.w - b.x) < EPS) {
        const from = Math.max(a.y, b.y);
        const to = Math.min(a.y + a.h, b.y + b.h);
        if (to - from > EPS) {
          get(a.panel.id).right.push({ from, to });
          get(b.panel.id).left.push({ from, to });
        }
      }
      if (Math.abs(a.y + a.h - b.y) < EPS) {
        const from = Math.max(a.x, b.x);
        const to = Math.min(a.x + a.w, b.x + b.w);
        if (to - from > EPS) {
          get(a.panel.id).bottom.push({ from, to });
          get(b.panel.id).top.push({ from, to });
        }
      }
    }
  }
  return cov;
}

/**
 * Snap a dragged panel to the viewport margins and to other panels — edge
 * alignment and FLUSH contact, the same snap language as nodes (the flush
 * boundary then dissolves via panelCoverage). Per-axis nearest candidate
 * within `threshold` px; panel-relative candidates apply only when the
 * rects actually meet on the orthogonal axis.
 */
export function panelSnap(
  x: number,
  y: number,
  w: number,
  h: number,
  others: PanelRect[],
  size: { width: number; height: number },
  threshold = 8,
): { x: number; y: number } {
  let sx = x;
  let sy = y;
  let bestX = threshold + 1;
  let bestY = threshold + 1;
  const tryX = (cand: number) => {
    const d = Math.abs(cand - x);
    if (d <= threshold && d < bestX) {
      bestX = d;
      sx = cand;
    }
  };
  const tryY = (cand: number) => {
    const d = Math.abs(cand - y);
    if (d <= threshold && d < bestY) {
      bestY = d;
      sy = cand;
    }
  };
  tryX(PANEL.margin);
  tryX(size.width - PANEL.margin - w);
  tryY(PANEL.margin);
  tryY(size.height - PANEL.margin - h);
  for (const o of others) {
    const xMeets = x < o.x + o.w + threshold && x + w > o.x - threshold;
    const yMeets = y < o.y + o.h + threshold && y + h > o.y - threshold;
    if (yMeets) {
      tryX(o.x); // align left edges
      tryX(o.x + o.w - w); // align right edges
      tryX(o.x + o.w); // flush against o's right side
      tryX(o.x - w); // flush against o's left side
    }
    if (xMeets) {
      tryY(o.y); // align tops
      tryY(o.y + o.h - h); // align bottoms
      tryY(o.y + o.h); // flush below o
      tryY(o.y - h); // flush above o
    }
  }
  return { x: sx, y: sy };
}

export function drawPanels(
  ctx: CanvasRenderingContext2D,
  rects: PanelRect[],
  theme?: RgTheme,
) {
  if (theme) T = theme;
  const cov = panelCoverage(rects);
  ctx.save();
  ctx.textBaseline = "middle";
  for (const r of rects) {
    const c: SideCoverage = cov.get(r.panel.id) ?? {
      top: [],
      right: [],
      bottom: [],
      left: [],
    };
    const rad = 6;
    // corners square off where a fused boundary reaches them
    const near = (ivs: Interval[], v: number) =>
      ivs.some((iv) => iv.from <= v + rad && iv.to >= v - rad);
    const tl = near(c.top, r.x) || near(c.left, r.y) ? 0 : rad;
    const tr = near(c.top, r.x + r.w) || near(c.right, r.y) ? 0 : rad;
    const br = near(c.bottom, r.x + r.w) || near(c.right, r.y + r.h) ? 0 : rad;
    const bl = near(c.bottom, r.x) || near(c.left, r.y + r.h) ? 0 : rad;

    // body
    ctx.beginPath();
    ctx.roundRect(r.x, r.y, r.w, r.h, [tl, tr, br, bl]);
    ctx.fillStyle = T.panelBg;
    ctx.fill();
    // border only on UNCOVERED segments — fused boundaries dissolve
    ctx.lineWidth = 1;
    ctx.strokeStyle = T.panelBorder;
    ctx.beginPath();
    for (const s of subtractIntervals({ from: r.x + tl, to: r.x + r.w - tr }, c.top)) {
      ctx.moveTo(s.from, r.y);
      ctx.lineTo(s.to, r.y);
    }
    for (const s of subtractIntervals({ from: r.y + tr, to: r.y + r.h - br }, c.right)) {
      ctx.moveTo(r.x + r.w, s.from);
      ctx.lineTo(r.x + r.w, s.to);
    }
    for (const s of subtractIntervals({ from: r.x + bl, to: r.x + r.w - br }, c.bottom)) {
      ctx.moveTo(s.from, r.y + r.h);
      ctx.lineTo(s.to, r.y + r.h);
    }
    for (const s of subtractIntervals({ from: r.y + tl, to: r.y + r.h - bl }, c.left)) {
      ctx.moveTo(r.x, s.from);
      ctx.lineTo(r.x, s.to);
    }
    if (tl) ctx.moveTo(r.x, r.y + tl), ctx.arc(r.x + tl, r.y + tl, tl, Math.PI, 1.5 * Math.PI);
    if (tr) ctx.moveTo(r.x + r.w - tr, r.y), ctx.arc(r.x + r.w - tr, r.y + tr, tr, 1.5 * Math.PI, 2 * Math.PI);
    if (br) ctx.moveTo(r.x + r.w, r.y + r.h - br), ctx.arc(r.x + r.w - br, r.y + r.h - br, br, 0, 0.5 * Math.PI);
    if (bl) ctx.moveTo(r.x + bl, r.y + r.h), ctx.arc(r.x + bl, r.y + r.h - bl, bl, 0.5 * Math.PI, Math.PI);
    ctx.stroke();

    // header
    ctx.beginPath();
    ctx.roundRect(
      r.x,
      r.y,
      r.w,
      PANEL.headerH,
      r.panel.collapsed ? [tl, tr, br, bl] : [tl, tr, 0, 0],
    );
    ctx.fillStyle = T.panelHeaderBg;
    ctx.fill();
    ctx.fillStyle = T.textDim;
    ctx.font = "bold 11px system-ui, sans-serif";
    ctx.textAlign = "left";
    ctx.fillText(r.panel.title, r.x + PANEL.pad, r.y + PANEL.headerH / 2 + 0.5);
    // collapse chevron
    ctx.fillStyle = T.textFaint;
    ctx.textAlign = "right";
    ctx.fillText(
      r.panel.collapsed ? "▸" : "▾",
      r.x + r.w - PANEL.pad,
      r.y + PANEL.headerH / 2 + 0.5,
    );

    if (r.panel.collapsed) continue;
    ctx.font = "11px system-ui, sans-serif";
    for (let i = 0; i < r.panel.items.length; i++) {
      const it = r.panel.items[i]!;
      const y = r.itemsY + (i + 0.5) * PANEL.rowH;
      ctx.beginPath();
      ctx.arc(r.x + PANEL.pad + 4, y, 3, 0, Math.PI * 2);
      ctx.fillStyle = it.color ?? T.textMuted;
      ctx.fill();
      ctx.fillStyle = T.text;
      ctx.textAlign = "left";
      ctx.fillText(it.label, r.x + PANEL.pad + 12, y);
    }
  }
  ctx.restore();
}

export type PanelHit =
  | { type: "header"; rect: PanelRect }
  | { type: "item"; rect: PanelRect; item: PanelItem }
  | { type: "body"; rect: PanelRect };

export function panelHitAt(
  rects: PanelRect[],
  sx: number,
  sy: number,
): PanelHit | null {
  // last panel drawn is on top
  for (let i = rects.length - 1; i >= 0; i--) {
    const r = rects[i]!;
    if (sx < r.x || sx > r.x + r.w || sy < r.y || sy > r.y + r.h) continue;
    if (sy <= r.y + PANEL.headerH) return { type: "header", rect: r };
    if (!r.panel.collapsed) {
      const idx = Math.floor((sy - r.itemsY) / PANEL.rowH);
      const item = r.panel.items[idx];
      if (item) return { type: "item", rect: r, item };
    }
    return { type: "body", rect: r };
  }
  return null;
}

/** ghost chip drawn at the cursor while dragging a palette item */
export function drawPanelDragGhost(
  ctx: CanvasRenderingContext2D,
  _t: ViewTransform,
  item: PanelItem,
  sx: number,
  sy: number,
  theme?: RgTheme,
) {
  if (theme) T = theme;
  ctx.save();
  ctx.font = "11px system-ui, sans-serif";
  ctx.textBaseline = "middle";
  const tw = ctx.measureText(item.label).width;
  ctx.beginPath();
  ctx.roundRect(sx + 10, sy - 11, tw + 24, 22, 5);
  ctx.fillStyle = T.panelBg;
  ctx.fill();
  ctx.strokeStyle = item.color ?? T.textMuted;
  ctx.lineWidth = 1.2;
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(sx + 20, sy, 3, 0, Math.PI * 2);
  ctx.fillStyle = item.color ?? T.textMuted;
  ctx.fill();
  ctx.fillStyle = T.text;
  ctx.textAlign = "left";
  ctx.fillText(item.label, sx + 28, sy);
  ctx.restore();
}
