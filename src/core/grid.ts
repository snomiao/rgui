/**
 * rgui core — readable-grid (rg) math.
 *
 * Framework-agnostic: pure functions from a viewer transform to grid geometry.
 * The grid is "screen-adaptive readable": whatever the zoom level, the grid
 * step in world units snaps to a ladder (default 1-2-5 * 10^n) so that its
 * on-screen spacing always stays within a readable pixel band.
 */
import { DEFAULT_RULE } from "./rule";

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
 * Pick the finest ladder step whose screen spacing >= minPx.
 */
export function readableStep(
  k: number,
  minPx = DEFAULT_RULE.minGridPx,
  ladder = DEFAULT_RULE.ladder,
): number {
  // smallest step s.t. step * k >= minPx, step in ladder * 10^n
  const raw = minPx / k;
  const exp = Math.floor(Math.log10(raw));
  const base = Math.pow(10, exp);
  for (const m of ladder) {
    if (m * base >= raw) return m * base;
  }
  return 10 * base;
}

/**
 * Grid levels for the current zoom: the major (readable) step plus the
 * next-finer minor step fading in as you zoom, so grid transitions are smooth.
 */
export function gridLevels(
  k: number,
  minPx = DEFAULT_RULE.minGridPx,
  ladder = DEFAULT_RULE.ladder,
): GridLevel[] {
  const major = readableStep(k, minPx, ladder);
  const minor = finerStep(major, ladder);
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

/** One rung finer on the ladder (default: 5 -> 2 -> 1 -> 0.5 ...). */
export function finerStep(step: number, ladder = DEFAULT_RULE.ladder): number {
  const exp = Math.floor(Math.log10(step) + 1e-9);
  const base = Math.pow(10, exp);
  const m = Math.round(step / base);
  const i = ladder.indexOf(m);
  if (i > 0) return ladder[i - 1]! * base;
  // below the ladder's first rung: drop a decade to its top rung
  return (ladder[ladder.length - 1]! * base) / 10;
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
