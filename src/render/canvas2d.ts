/**
 * First (simple) renderer: Canvas 2D.
 * Composes draw layers over a dark background; the base layer draws
 * yellow dots at every readable-grid intersection at viewer scale.
 * A WebGPU renderer will replace this behind the same interface.
 */
import {
  gridLevels,
  gridRange,
  type ViewTransform,
} from "../core/grid.js";
import { DEFAULT_RULE, type RgRule } from "../core/rule.js";

export type DrawLayer = (
  ctx: CanvasRenderingContext2D,
  t: ViewTransform,
  size: { width: number; height: number },
) => void;

export interface GridRenderer {
  render(t: ViewTransform): void;
  resize(): void;
}

export function createCanvas2DRenderer(
  canvas: HTMLCanvasElement,
  layers: DrawLayer[],
): GridRenderer {
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2d context unavailable");

  let width = 0;
  let height = 0;
  let dpr = 1;

  function resize() {
    dpr = window.devicePixelRatio || 1;
    width = canvas.clientWidth;
    height = canvas.clientHeight;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
  }

  function render(t: ViewTransform) {
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = "#1c2126";
    ctx.fillRect(0, 0, width, height);
    for (const layer of layers) layer(ctx, t, { width, height });
  }

  resize();
  return { render, resize };
}

/** Base layer: yellow dots at every readable-grid point at viewer scale. */
export function createGridDotsLayer(rule: RgRule = DEFAULT_RULE): DrawLayer {
  return (ctx, t, { width, height }) => {
  const levels = gridLevels(t.k, rule.minGridPx, rule.ladder);
  // finest level first so major dots draw on top
  for (const level of [...levels].reverse()) {
    if (level.alpha <= 0.01) continue;
    const { start: x0, end: x1 } = gridRange(t, 0, width, t.x, level.step);
    const { start: y0, end: y1 } = gridRange(t, 0, height, t.y, level.step);

    const major = level.step === levels[0]!.step;
    const r = major ? 2.5 : 1.5;
    const alpha = level.alpha * (major ? 0.55 : 0.3);
    ctx.fillStyle = `rgba(255, 214, 10, ${alpha})`;
    ctx.beginPath();
    for (let wx = x0; wx <= x1; wx += level.step) {
      const sx = wx * t.k + t.x;
      for (let wy = y0; wy <= y1; wy += level.step) {
        const sy = wy * t.k + t.y;
        ctx.moveTo(sx + r, sy);
        ctx.arc(sx, sy, r, 0, Math.PI * 2);
      }
    }
    ctx.fill();
  }
  };
}

/** Default grid-dots layer using DEFAULT_RULE. */
export const gridDotsLayer: DrawLayer = createGridDotsLayer();
