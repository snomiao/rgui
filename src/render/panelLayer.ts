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

export function drawPanels(
  ctx: CanvasRenderingContext2D,
  rects: PanelRect[],
  theme?: RgTheme,
) {
  if (theme) T = theme;
  ctx.save();
  ctx.textBaseline = "middle";
  for (const r of rects) {
    // body
    ctx.beginPath();
    ctx.roundRect(r.x, r.y, r.w, r.h, 6);
    ctx.fillStyle = T.panelBg;
    ctx.fill();
    ctx.lineWidth = 1;
    ctx.strokeStyle = T.panelBorder;
    ctx.stroke();

    // header
    ctx.beginPath();
    ctx.roundRect(r.x, r.y, r.w, PANEL.headerH, r.panel.collapsed ? 6 : [6, 6, 0, 0]);
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
