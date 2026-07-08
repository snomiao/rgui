/**
 * rgui lane — the anisotropic view.
 *
 * Where the infinite canvas (src/rgui.ts) uses ONE isotropic scale `k`
 * (screen = world·k + t on both axes), the lane zooms only ONE axis. Data
 * here is 1-D: it flows down the screen. The **flow axis** (vertical) zooms
 * and scrolls; the **width axis** (horizontal) is pinned to the viewport.
 *
 * So zooming in makes every row taller — and, via semantic-zoom LOD, reveals
 * more detail — while its width never changes. That is the whole point of
 * "limited-visual-width" mode, and it is still a renormalization-group flow:
 * at each scale only the couplings that stay readable survive. It just runs
 * along a single axis.
 */
import { readableStep } from "../core/grid.js";
import { DEFAULT_RULE, type RgRule } from "../core/rule.js";

export interface LaneView {
  /** world-unit at the top edge of the viewport (flow-axis scroll offset) */
  scrollY: number;
  /** screen px per world unit along the flow axis — the ONLY zoom */
  zoomY: number;
  /** viewport width px (the pinned axis: content is laid out in px here) */
  width: number;
  /** viewport height px (the scroll span of the flow axis) */
  height: number;
}

/** flow-axis: world → screen y. */
export const worldToScreenY = (v: LaneView, wy: number) =>
  (wy - v.scrollY) * v.zoomY;

/** flow-axis: screen → world y. */
export const screenToWorldY = (v: LaneView, sy: number) =>
  sy / v.zoomY + v.scrollY;

/** flow-axis world span currently visible (world units per viewport). */
export const visibleSpan = (v: LaneView) => v.height / v.zoomY;

/**
 * Zoom by `factor` about a fixed screen-y anchor (keep the world point under
 * the cursor/center pinned). Clamped to [min, max] zoom.
 */
export function zoomAt(
  v: LaneView,
  factor: number,
  anchorScreenY: number,
  limits: { min: number; max: number },
): void {
  const wy = screenToWorldY(v, anchorScreenY);
  const z = Math.min(limits.max, Math.max(limits.min, v.zoomY * factor));
  v.zoomY = z;
  v.scrollY = wy - anchorScreenY / z;
}

/**
 * Clamp scroll to the source extent. When content is shorter than the
 * viewport it pins to the top; otherwise it keeps the content edge-to-edge
 * without overscroll (a little bottom slack so the last row isn't glued to
 * the edge).
 */
export function clampScroll(
  v: LaneView,
  extent: { min: number; max: number },
  bottomSlackPx = 0,
): void {
  const span = visibleSpan(v);
  const slack = bottomSlackPx / v.zoomY;
  const contentSpan = extent.max - extent.min;
  if (contentSpan + slack <= span) {
    v.scrollY = extent.min;
  } else {
    const maxScroll = extent.max + slack - span;
    v.scrollY = Math.min(Math.max(v.scrollY, extent.min), maxScroll);
  }
}

/**
 * The readable flow-axis step (world units per readable cell) at the current
 * zoom — the RG ladder from src/core/grid.ts, applied to the single axis.
 * Sources use it to choose gridline spacing and aggregation buckets.
 */
export const lodStep = (v: LaneView, rule: RgRule = DEFAULT_RULE) =>
  readableStep(v.zoomY, rule.minGridPx, rule.radix);
