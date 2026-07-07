/**
 * First (simple) renderer: Canvas 2D.
 * Composes draw layers over a dark background; the base layer draws
 * field arrows (⊙ purple toward the viewer / ⊗ gold cross away) at every
 * readable-grid intersection at viewer scale.
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
  opts?: {
    /** background fill; false = transparent (compositing over an underlay) */
    background?: string | false;
  },
): GridRenderer {
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2d context unavailable");
  const background = opts?.background ?? "#1c2126";

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
    if (background === false) {
      ctx.clearRect(0, 0, width, height);
    } else {
      ctx.fillStyle = background;
      ctx.fillRect(0, 0, width, height);
    }
    for (const layer of layers) layer(ctx, t, { width, height });
  }

  resize();
  return { render, resize };
}

/** world-space attractors that bend the grid field (e.g. off-screen nodes) */
export type FieldSource = { x: number; y: number };

/** field-arrow colors: ⊙ toward the viewer = mascot purple, ⊗ away = gold */
const ARROW_OUT_RGB = "178, 92, 224"; // #b25ce0
const ARROW_IN_RGB = "255, 214, 10"; // #ffd60a

/**
 * Base layer: every readable-grid point is a unit 3-D FIELD ARROW.
 * By default the arrows point at the viewer and render as purple dots (⊙,
 * the arrowhead seen head-on). When `zDir` reports the field pointing into
 * the screen (e.g. while zooming out), they flip to gold crosses (⊗, the
 * fletching seen from behind) — the physics notation for out-of/into the
 * page. With a `field` provider, major arrows tilt sideways under the
 * inverse-square pull of the sources (off-screen nodes feel like gravity —
 * the RG flow made visible) and grow a tail. One path per level: perf flat.
 */
export function createGridDotsLayer(
  rule: RgRule = DEFAULT_RULE,
  field?: () => FieldSource[],
  /** z of the field arrows: +1 = at the viewer (⊙), -1 = into the screen (⊗) */
  zDir?: () => number,
  getAngle?: () => number,
): DrawLayer {
  return (ctx, t, { width, height }) => {
  const z = Math.max(-1, Math.min(1, zDir?.() ?? 1));
  const toward = z >= 0;
  const rgb = toward ? ARROW_OUT_RGB : ARROW_IN_RGB;
  const levels = gridLevels(t.k, rule.minGridPx, rule.ladder);
  // rotated viewport → cover the half-diagonal AABB so corners stay filled
  const rot = getAngle?.() ?? 0;
  const hd = rot ? Math.hypot(width, height) / 2 : 0;
  const bx0 = rot ? width / 2 - hd : 0;
  const bx1 = rot ? width / 2 + hd : width;
  const by0 = rot ? height / 2 - hd : 0;
  const by1 = rot ? height / 2 + hd : height;
  // screen-space attractors (capped for safety)
  const attractors = (field?.() ?? []).slice(0, 128).map((a) => ({
    x: a.x * t.k + t.x,
    y: a.y * t.k + t.y,
  }));
  // finest level first so major dots draw on top
  for (const level of [...levels].reverse()) {
    if (level.alpha <= 0.01) continue;
    const { start: x0, end: x1 } = gridRange(t, bx0, bx1, t.x, level.step);
    const { start: y0, end: y1 } = gridRange(t, by0, by1, t.y, level.step);

    const major = level.step === levels[0]!.step;
    const r = major ? 2.5 : 1.5;
    const alpha = level.alpha * (major ? 0.55 : 0.3);
    ctx.fillStyle = `rgba(${rgb}, ${alpha})`;
    ctx.beginPath();
    const tails: number[] = []; // [x0,y0,x1,y1,...] collected per level
    const crosses: number[] = []; // [cx,cy,arm,...] when arrows point away
    for (let wx = x0; wx <= x1; wx += level.step) {
      const sx = wx * t.k + t.x;
      for (let wy = y0; wy <= y1; wy += level.step) {
        const sy = wy * t.k + t.y;
        // each grid point is a unit 3D field arrow (⊙ at the viewer by
        // default); pull from off-screen nodes tilts it sideways — the
        // projection shrinks the head and grows a tail
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
        if (toward) {
          ctx.moveTo(sx + dotR, sy);
          ctx.arc(sx, sy, dotR, 0, Math.PI * 2);
        } else {
          crosses.push(sx, sy, dotR * 1.4);
        }
      }
    }
    if (toward) ctx.fill();
    if (crosses.length) {
      ctx.strokeStyle = `rgba(${rgb}, ${alpha})`;
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let i = 0; i < crosses.length; i += 3) {
        const cx = crosses[i]!, cy = crosses[i + 1]!, s = crosses[i + 2]!;
        ctx.moveTo(cx - s, cy - s);
        ctx.lineTo(cx + s, cy + s);
        ctx.moveTo(cx - s, cy + s);
        ctx.lineTo(cx + s, cy - s);
      }
      ctx.stroke();
    }
    if (tails.length) {
      ctx.strokeStyle = `rgba(${rgb}, ${alpha * 0.7})`;
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
