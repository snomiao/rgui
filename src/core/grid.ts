/**
 * rgui core — readable-grid (rg) math.
 *
 * Framework-agnostic: pure functions from a viewer transform to grid geometry.
 * The grid is "screen-adaptive readable" AND radix-layered: grid scales are
 * powers of a configurable radix (default 8 — 八进制), so one higher-order
 * cell contains radix sub-steps per axis (radix² cells). Whatever the zoom,
 * the on-screen spacing of the main grid stays within a readable pixel band.
 */
import { DEFAULT_RULE } from "./rule.js";

/** Viewer transform: screen = world * k + t (per axis). */
export interface ViewTransform {
  x: number; // screen-space translation x (px)
  y: number; // screen-space translation y (px)
  k: number; // scale: screen px per world unit
}

export interface GridLevel {
  /** grid step in world units (on the ladder) */
  step: number;
  /** grid step in screen px = step * k */
  px: number;
  /** 0..1 fade factor for smooth appearance while zooming */
  alpha: number;
}

/**
 * Pick the finest radix-power step whose screen spacing >= minPx.
 */
export function readableStep(
  k: number,
  minPx = DEFAULT_RULE.minGridPx,
  radix = DEFAULT_RULE.radix,
): number {
  // smallest step = radix^n (n ∈ ℤ) s.t. step * k >= minPx
  const raw = minPx / k;
  const n = Math.ceil(Math.log(raw) / Math.log(radix) - 1e-9);
  return Math.pow(radix, n);
}

/**
 * Grid levels for the current zoom: the major (readable) step plus the
 * next-finer minor step fading in as you zoom, so grid transitions are smooth.
 */
export function gridLevels(
  k: number,
  minPx = DEFAULT_RULE.minGridPx,
  radix = DEFAULT_RULE.radix,
): GridLevel[] {
  const major = readableStep(k, minPx, radix);
  const minor = finerStep(major, radix);
  const minorPx = minor * k;
  // minor fades in from 0 at minPx/ratio up to 1 when it reaches minPx
  const ratio = major / minor;
  const t = (minorPx - minPx / ratio) / (minPx - minPx / ratio);
  const alpha = Math.min(1, Math.max(0, t));
  return [
    { step: major, px: major * k, alpha: 1 },
    { step: minor, px: minorPx, alpha },
  ];
}

/** One layer finer: step / radix. */
export function finerStep(step: number, radix = DEFAULT_RULE.radix): number {
  return step / radix;
}

/**
 * The layer a size LIVES on: the step L (radix power) where the size spans
 * 1..radix grids. This is a node's intrinsic scale — its position snaps to
 * this layer's lattice (or the viewing grid, whichever is coarser).
 */
export function sizeLayerStep(
  size: number,
  radix = DEFAULT_RULE.radix,
  baseStep = 1,
): number {
  if (size <= 0) return baseStep;
  let step = baseStep;
  while (step * radix < size) step *= radix;
  return step;
}

/**
 * The node-size law: a size must span an INTEGER number of grids between
 * 1 and radix at SOME layer. A size needing more than radix grids at a
 * layer promotes to the next layer, snapped to the upper limit —
 * e.g. 9 grids at layer s (radix 8) becomes 2 grids at layer s+1.
 */
export function snapSizeRadix(
  size: number,
  radix = DEFAULT_RULE.radix,
  /** the finest layer's step (world units) to start from */
  baseStep = 1,
): number {
  if (size <= 0) return baseStep;
  let step = baseStep;
  // find the coarsest layer whose single grid does not exceed the size
  while (step * radix < size) step *= radix;
  const cells = Math.ceil(size / step - 1e-9);
  if (cells <= radix) return cells * step;
  // needs more than radix grids → promote and snap up
  return Math.ceil(cells / radix) * step * radix;
}

/**
 * How a node's two axes pick the layer they snap on.
 *
 * - "per-axis" (default): each axis obeys the size law alone. A 2-grid
 *   width stays 2 grids; a 9-grid height has outgrown its layer, so it
 *   promotes and becomes 2 grids of the next one — 16 fine grids. The
 *   node's own aspect ratio has no say.
 * - "finest-axis": the SHORTER axis names the node's cell, and the longer
 *   one is an integer count of that same cell. 2 × 9 stays 2 × 9. One node,
 *   one cell size — at the cost of letting the long axis run past `radix`
 *   grids, which the per-axis law forbids.
 */
export type SizeLaw = "per-axis" | "finest-axis";

/**
 * The step a node's WIDTH snaps on, given the height it will end up with.
 * Under "per-axis" the height is irrelevant.
 */
export function sizeStepFor(
  w: number,
  h: number,
  radix = DEFAULT_RULE.radix,
  law: SizeLaw = "per-axis",
  baseStep = 1,
): number {
  const sw = sizeLayerStep(w, radix, baseStep);
  if (law === "per-axis") return sw;
  return Math.min(sw, sizeLayerStep(h, radix, baseStep));
}

/** snap a node's size under the active size law */
export function snapNodeSize(
  w: number,
  h: number,
  radix = DEFAULT_RULE.radix,
  law: SizeLaw = "per-axis",
  baseStep = 1,
): { w: number; h: number } {
  if (law === "per-axis")
    return {
      w: snapSizeRadix(w, radix, baseStep),
      h: snapSizeRadix(h, radix, baseStep),
    };
  const step = sizeStepFor(w, h, radix, law, baseStep);
  const cells = (v: number) => Math.max(1, Math.ceil(v / step - 1e-9)) * step;
  return { w: cells(w), h: cells(h) };
}

/** Iterate world-space grid coordinates visible in a screen rect. */
export function gridRange(
  t: ViewTransform,
  screenMin: number,
  screenMax: number,
  offset: number,
  step: number,
): { start: number; end: number } {
  // world = (screen - offset) / k
  const w0 = (screenMin - offset) / t.k;
  const w1 = (screenMax - offset) / t.k;
  return {
    start: Math.floor(w0 / step) * step,
    end: Math.ceil(w1 / step) * step,
  };
}

/** Snap a world coordinate to the nearest grid point of the given step. */
export const snap = (v: number, step: number) => Math.round(v / step) * step;

export const worldToScreen = (t: ViewTransform, wx: number, wy: number) =>
  [wx * t.k + t.x, wy * t.k + t.y] as const;

export const screenToWorld = (t: ViewTransform, sx: number, sy: number) =>
  [(sx - t.x) / t.k, (sy - t.y) / t.k] as const;
