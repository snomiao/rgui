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

/** world-space attractors that bend the grid field (e.g. off-screen nodes) */
export type FieldSource = { x: number; y: number };

/**
 * Base layer: yellow dots at every readable-grid point at viewer scale.
 * With a `field` provider, major dots grow a tail pointing along the
 * inverse-square pull of the sources (off-screen nodes feel like gravity —
 * the RG flow made visible). One path per level: perf stays flat.
 */
export function createGridDotsLayer(
  rule: RgRule = DEFAULT_RULE,
  field?: () => FieldSource[],
): DrawLayer {
  return (ctx, t, { width, height }) => {
  const levels = gridLevels(t.k, rule.minGridPx, rule.ladder);
  // screen-space attractors (capped for safety)
  const attractors = (field?.() ?? []).slice(0, 128).map((a) => ({
    x: a.x * t.k + t.x,
    y: a.y * t.k + t.y,
  }));
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
    const tails: number[] = []; // [x0,y0,x1,y1,...] collected per level
    for (let wx = x0; wx <= x1; wx += level.step) {
      const sx = wx * t.k + t.x;
      for (let wy = y0; wy <= y1; wy += level.step) {
        const sy = wy * t.k + t.y;
        // each dot is a unit 3D field vector pointing AT the viewer; pull
        // from off-screen nodes tilts it sideways — the projection shrinks
        // the dot and grows a tail (dot = arrow seen head-on)
        let dotR = r;
        if (major && attractors.length) {
          let vx = 0;
          let vy = 0;
          for (const a of attractors) {
            const dx = a.x - sx;
            const dy = a.y - sy;
            const d2 = dx * dx + dy * dy;
            if (d2 < 1) continue;
            // inverse-square pull toward every off-screen node
            vx += dx / d2;
            vy += dy / d2;
          }
          const mag = Math.hypot(vx, vy);
          if (mag > 1e-4) {
            const tilt = Math.min(1, mag * 900); // 0 = at viewer, 1 = flat
            const len = 3 + 11 * tilt;
            dotR = r * (1 - 0.55 * tilt);
            tails.push(sx, sy, sx + (vx / mag) * len, sy + (vy / mag) * len);
          }
        }
        ctx.moveTo(sx + dotR, sy);
        ctx.arc(sx, sy, dotR, 0, Math.PI * 2);
      }
    }
    ctx.fill();
    if (tails.length) {
      ctx.strokeStyle = `rgba(255, 214, 10, ${alpha * 0.7})`;
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let i = 0; i < tails.length; i += 4) {
        ctx.moveTo(tails[i]!, tails[i + 1]!);
        ctx.lineTo(tails[i + 2]!, tails[i + 3]!);
      }
      ctx.stroke();
    }
  }
  };
}

/** Default grid-dots layer using DEFAULT_RULE. */
export const gridDotsLayer: DrawLayer = createGridDotsLayer();
