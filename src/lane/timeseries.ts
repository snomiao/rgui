/**
 * rgui lane source — time series (semantic-zoom waveform).
 *
 * The flow axis is TIME (world y = sample index); the pinned width axis is the
 * value/amplitude lane. Zoom reveals temporal detail without ever changing the
 * lane width:
 *
 *   • zoomed out (< a few px per sample) → each screen row aggregates the
 *     samples that fall in it into a min–max ribbon (the classic waveform
 *     envelope), so a whole series reads at a glance.
 *   • zoomed in  → the ribbon resolves into a polyline through individual
 *     samples; zoom further and each sample gets a dot and a value label.
 *
 * Time gridlines/labels are placed on the readable ladder (src/core/grid.ts)
 * applied to the single axis — the same RG flow the infinite canvas uses,
 * limited to one dimension.
 */
import { withAlpha } from "../core/theme.js";
import type { LaneEnv, LaneSource } from "./lane.js";
import { screenToWorldY, worldToScreenY, type LaneView } from "./view.js";

export interface SeriesOptions {
  /** samples per second — maps sample index → clock time for labels */
  sampleRate?: number;
  label?: string;
  /** trace color (defaults to the mascot purple) */
  color?: string;
  /**
   * symlog value axis (default false): x = sign(v)·log1p(|v|/linthresh),
   * so a large burst compresses and the small wiggles around it expand.
   * Works with bipolar signals (unlike a plain log axis).
   */
  logScale?: boolean;
  /** symlog linear-region threshold (default 0.05) */
  linthresh?: number;
}

const PAD_X = 14;
const SPINE_MIN_PX = 3; // px/sample below this → aggregate to a min–max ribbon
const DOT_MIN_PX = 16; // px/sample above this → dots + per-sample value labels

function fmtTime(sec: number, stepSec: number): string {
  const sign = sec < 0 ? "-" : "";
  sec = Math.abs(sec);
  const m = Math.floor(sec / 60);
  const s = sec - m * 60;
  const dec = stepSec < 1 ? (stepSec < 0.1 ? 2 : 1) : 0;
  const ss = s.toFixed(dec).padStart(dec ? 3 + dec : 2, "0");
  return `${sign}${m}:${ss}`;
}

export function createSeriesSource(
  samples: ArrayLike<number>,
  opts: SeriesOptions = {},
): LaneSource {
  const n = samples.length;
  const rate = opts.sampleRate ?? 1;
  const color = opts.color ?? "#b25ce0";
  let vmin = Infinity;
  let vmax = -Infinity;
  for (let i = 0; i < n; i++) {
    const v = samples[i]!;
    if (v < vmin) vmin = v;
    if (v > vmax) vmax = v;
  }
  if (!isFinite(vmin)) {
    vmin = 0;
    vmax = 1;
  }
  // value → axis coordinate (identity, or symlog for high-dynamic-range signals)
  const linthresh = opts.linthresh ?? 0.05;
  const axis = opts.logScale
    ? (v: number) => Math.sign(v) * Math.log1p(Math.abs(v) / linthresh)
    : (v: number) => v;
  const amin = axis(vmin);
  const amax = axis(vmax);
  const aspan = amax - amin || 1;

  function draw(ctx: CanvasRenderingContext2D, view: LaneView, env: LaneEnv) {
    const { theme } = env;
    const W = view.width;
    const H = view.height;
    const contentX0 = PAD_X;
    const contentW = W - PAD_X * 2;
    // value → x (through the axis transform), inset from the lane edges
    const valX = (v: number) =>
      contentX0 + ((axis(v) - amin) / aspan) * contentW * 0.84 + contentW * 0.08;

    // fixed-width lane borders — make "width never changes" visible
    ctx.strokeStyle = withAlpha(theme.textFaint, 0.4);
    ctx.lineWidth = 1;
    for (const gx of [contentX0, contentX0 + contentW]) {
      ctx.beginPath();
      ctx.moveTo(gx + 0.5, 0);
      ctx.lineTo(gx + 0.5, H);
      ctx.stroke();
    }
    // zero (or center) baseline
    const zeroV = vmin <= 0 && vmax >= 0 ? 0 : (vmin + vmax) / 2;
    const zx = valX(zeroV);
    ctx.strokeStyle = withAlpha(theme.textFaint, 0.55);
    ctx.beginPath();
    ctx.moveTo(zx + 0.5, 0);
    ctx.lineTo(zx + 0.5, H);
    ctx.stroke();

    // ── time gridlines on the readable ladder ────────────────────────────
    const step = env.lodStep; // world units (samples) per readable cell
    const topW = screenToWorldY(view, 0);
    const botW = screenToWorldY(view, H);
    ctx.textBaseline = "middle";
    ctx.font = "10px ui-monospace, Menlo, monospace";
    const stepSec = step / rate;
    for (
      let g = Math.floor(topW / step) * step;
      g <= botW + step;
      g += step
    ) {
      const gy = worldToScreenY(view, g);
      ctx.strokeStyle = withAlpha(theme.textFaint, 0.16);
      ctx.beginPath();
      ctx.moveTo(0, gy + 0.5);
      ctx.lineTo(W, gy + 0.5);
      ctx.stroke();
      if (g >= 0 && g <= n) {
        ctx.fillStyle = theme.textMuted;
        ctx.textAlign = "left";
        ctx.fillText(fmtTime(g / rate, stepSec), 4, gy - 7);
      }
    }

    // ── the trace ────────────────────────────────────────────────────────
    const pxPerSample = view.zoomY;
    const lo = Math.max(0, Math.floor(topW) - 1);
    const hi = Math.min(n - 1, Math.ceil(botW) + 1);
    if (hi < lo) return;

    if (pxPerSample < SPINE_MIN_PX) {
      // aggregate: per-screen-row min–max ribbon
      drawEnvelope(ctx, view, lo, hi, valX, color, theme);
    } else {
      // resolve: polyline through samples
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      for (let i = lo; i <= hi; i++) {
        const x = valX(samples[i]!);
        const y = worldToScreenY(view, i + 0.5);
        i === lo ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      }
      ctx.stroke();
      if (pxPerSample >= DOT_MIN_PX) {
        drawDots(ctx, view, lo, hi, valX, color, theme);
      }
    }

    // value scale labels (top corners) — the fixed amplitude axis
    ctx.font = "10px ui-monospace, Menlo, monospace";
    ctx.fillStyle = theme.textFaint;
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    ctx.fillText(vmin.toFixed(2), valX(vmin), H - 14);
    ctx.textAlign = "right";
    ctx.fillText(vmax.toFixed(2), valX(vmax), H - 14);
  }

  function drawEnvelope(
    ctx: CanvasRenderingContext2D,
    view: LaneView,
    lo: number,
    hi: number,
    valX: (v: number) => number,
    color: string,
    theme: { text: string },
  ) {
    void theme;
    // bucket samples into screen rows; track min & max value per row
    const y0 = worldToScreenY(view, lo);
    const rows = Math.max(1, Math.ceil(worldToScreenY(view, hi + 1) - y0) + 1);
    const mins = new Float64Array(rows).fill(Infinity);
    const maxs = new Float64Array(rows).fill(-Infinity);
    for (let i = lo; i <= hi; i++) {
      const py = worldToScreenY(view, i + 0.5) - y0;
      const r = py < 0 ? 0 : py >= rows ? rows - 1 : py | 0;
      const v = samples[i]!;
      if (v < mins[r]!) mins[r] = v;
      if (v > maxs[r]!) maxs[r] = v;
    }
    ctx.fillStyle = withAlpha(color, 0.5);
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    for (let r = 0; r < rows; r++) {
      if (mins[r] === Infinity) continue;
      const y = y0 + r;
      const xa = valX(mins[r]!);
      const xb = valX(maxs[r]!);
      ctx.fillRect(xa, y, Math.max(1, xb - xa), 1);
    }
  }

  function drawDots(
    ctx: CanvasRenderingContext2D,
    view: LaneView,
    lo: number,
    hi: number,
    valX: (v: number) => number,
    color: string,
    theme: { text: string; textMuted: string },
  ) {
    ctx.fillStyle = color;
    const labels = view.zoomY >= DOT_MIN_PX * 1.6;
    for (let i = lo; i <= hi; i++) {
      const x = valX(samples[i]!);
      const y = worldToScreenY(view, i + 0.5);
      ctx.beginPath();
      ctx.arc(x, y, 2.5, 0, Math.PI * 2);
      ctx.fill();
      if (labels) {
        ctx.fillStyle = theme.textMuted;
        ctx.textAlign = "left";
        ctx.textBaseline = "middle";
        ctx.font = "10px ui-monospace, Menlo, monospace";
        ctx.fillText(samples[i]!.toFixed(3), x + 6, y);
        ctx.fillStyle = color;
      }
    }
  }

  return {
    title: (opts.label ?? "time series") + (opts.logScale ? " · symlog" : ""),
    extent: () => ({ min: 0, max: n }),
    // one sample can grow tall; allow deep zoom
    maxZoom: 80,
    draw,
    hudLine: (view) => {
      const idx = Math.round(screenToWorldY(view, view.height / 2));
      if (idx < 0 || idx >= n) return null;
      return `t=${fmtTime(idx / rate, 1 / rate)} · v=${samples[idx]!.toFixed(3)}`;
    },
  };
}
