/**
 * Homepage hero cube — the Kadanoff block-spin picture, live.
 *
 * An N×N×N voxel cube rotates in the corner. N follows the demo viewer's zoom:
 * zoom out → blocks coarse-grain (…5³ → 4³ → … → 1³), zoom in → they refine.
 * Colors come from the same pattern rule as the mascot icon — the Royal Gramma
 * purple→gold crossover as a 3-D field, dithered per cell — and when blocks
 * merge, each parent takes the MAJORITY color of the fine cells it contains:
 * a real renormalization of the color field.
 *
 * Pure DOM + canvas overlay; reads window.viewer.view.k, touches nothing else.
 */

const PALETTE = ["#3a2ea6", "#9b34bf", "#f3820d", "#ffd21c"] as const;
const RGB = PALETTE.map((h) => {
  const n = parseInt(h.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255] as const;
});

// ---- the pattern rule (same math as assets/icon-lab.html) ----
const KXY = Math.SQRT1_2;
// head points to the up-left-front corner (cube-local), so the color field runs
// purple (head corner) → gold (tail corner) like the icon's TL→BR crossover.
const HEAD = (() => {
  const v = [-1, -1, 1] as const;
  const n = Math.hypot(...v);
  return [v[0] / n, v[1] / n, v[2] / n] as const;
})();
const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const field = (x: number, y: number, z: number) =>
  clamp01(0.5 - KXY * (x * HEAD[0] + y * HEAD[1] + z * HEAD[2]));
const hash3 = (ix: number, iy: number, iz: number) => {
  let h = Math.imul(ix | 0, 374761393) ^ Math.imul(iy | 0, 668265263) ^ Math.imul(iz | 0, 2246822519);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
};
const rampIdx = (t: number, thr: number) => {
  const v = clamp01(t) * 3;
  const i = Math.floor(v);
  return i >= 3 ? 3 : v - i > thr ? i + 1 : i;
};

// ---- fine lattice (the "microscopic" spins) + block-spin majority vote ----
const F = 12; // fine cells per axis
const fine = new Uint8Array(F * F * F);
for (let k = 0; k < F; k++)
  for (let j = 0; j < F; j++)
    for (let i = 0; i < F; i++) {
      const c = (v: number) => (v + 0.5) / F - 0.5;
      fine[(k * F + j) * F + i] = rampIdx(field(c(i), c(j), c(k)), hash3(i, j, k));
    }
/** color of block (i,j,k) at subdivision N = majority vote of its fine cells */
function blockColor(i: number, j: number, k: number, N: number): number {
  const lo = (b: number) => Math.floor((b * F) / N);
  const hi = (b: number) => Math.max(lo(b) + 1, Math.floor(((b + 1) * F) / N));
  const votes = [0, 0, 0, 0];
  for (let z = lo(k); z < hi(k); z++)
    for (let y = lo(j); y < hi(j); y++)
      for (let x = lo(i); x < hi(i); x++) votes[fine[(z * F + y) * F + x]!]!++;
  let best = 0;
  for (let c = 1; c < 4; c++) if (votes[c]! > votes[best]!) best = c;
  return best;
}

// ---- widget DOM ----
const wrap = document.createElement("div");
wrap.id = "hero-cube";
wrap.style.cssText =
  "position:fixed;right:18px;bottom:18px;z-index:30;pointer-events:none;" +
  "display:flex;flex-direction:column;align-items:center;gap:2px;";
const cv = document.createElement("canvas");
const CSS = 168;
cv.width = CSS * devicePixelRatio;
cv.height = CSS * devicePixelRatio;
cv.style.cssText = `width:${CSS}px;height:${CSS}px;`;
const cap = document.createElement("div");
cap.style.cssText =
  "font:11px ui-monospace,monospace;color:var(--text-faint,#5c6570);letter-spacing:.06em;transition:color 150ms;";
wrap.append(cv, cap);
document.body.appendChild(wrap);
const ctx = cv.getContext("2d")!;
ctx.scale(devicePixelRatio, devicePixelRatio);

// ---- subdivision follows zoom: coarse-grain on zoom-out, refine on zoom-in ----
type ViewerLike = { view?: { k: number } };
const getK = () => (window as unknown as { viewer?: ViewerLike }).viewer?.view?.k ?? 1;
const subdivisions = (k: number) => Math.max(1, Math.min(6, Math.round(4 + Math.log2(k))));

// ---- tiny software renderer: orthographic voxels, painter's algorithm ----
const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
let lastN = -1;
function draw(tMs: number) {
  const N = subdivisions(getK());
  if (N !== lastN) {
    lastN = N;
    cap.textContent = `${N}³ block-spin · zoom to renormalize`;
    cap.style.color = "var(--accent, #ffd60a)";
    setTimeout(() => (cap.style.color = "var(--text-faint, #5c6570)"), 400);
  }
  // gizmo contract: when the viewer has a 3-D orientation, the cube SHOWS
  // it (drag the cube → the canvas and the cube rotate together); otherwise
  // it keeps its ambient slow spin
  const r3 = (window as unknown as {
    viewer?: { rotation3?: { yaw: number; pitch: number; roll: number } };
  }).viewer?.rotation3;
  const oriented = !!r3 && !!(r3.yaw || r3.pitch || r3.roll);
  const ay = oriented ? 0.7 + r3.yaw : reduced ? 0.7 : tMs * 0.00035; // spin
  const ax = oriented ? 0.42 + r3.pitch : 0.42; // tilt
  const cy = Math.cos(ay), sy = Math.sin(ay), cx = Math.cos(ax), sx = Math.sin(ax);
  const R = 58; // cube radius in px
  const cell = 1 / N, s = cell * 0.97;

  type Face = { z: number; pts: [number, number][]; fill: string };
  const faces: Face[] = [];
  const proj = (x: number, y: number, z: number): [number, number, number] => {
    // rotate Y then X, orthographic
    const x1 = x * cy + z * sy, z1 = -x * sy + z * cy;
    const y2 = y * cx - z1 * sx, z2 = y * sx + z1 * cx;
    return [CSS / 2 + x1 * 2 * R, CSS / 2 + y2 * 2 * R, z2];
  };
  const shade = ([r, g, b]: readonly [number, number, number], m: number) =>
    `rgb(${(r * m) | 0},${(g * m) | 0},${(b * m) | 0})`;

  for (let k = 0; k < N; k++)
    for (let j = 0; j < N; j++)
      for (let i = 0; i < N; i++) {
        const bx = (i + 0.5) * cell - 0.5, by = (j + 0.5) * cell - 0.5, bz = (k + 0.5) * cell - 0.5;
        const rgb = RGB[blockColor(i, j, k, N)] ?? RGB[0]!;
        const h = s / 2;
        // 8 corners
        const c: [number, number, number][] = [];
        for (let d = 0; d < 8; d++)
          c.push(proj(bx + (d & 1 ? h : -h), by + (d & 2 ? h : -h), bz + (d & 4 ? h : -h)));
        // quads: [corner ids], shading, outward axis for backface test via winding
        const quads: [number[], number][] = [
          [[2, 3, 7, 6], 1.0],   // top (y+ is down on screen; this is y+... shading below)
          [[0, 1, 5, 4], 0.55],  // bottom
          [[1, 3, 7, 5], 0.8],   // x+
          [[0, 2, 6, 4], 0.7],   // x-
          [[4, 5, 7, 6], 0.9],   // z+
          [[0, 1, 3, 2], 0.65],  // z-
        ];
        for (const [ids, m] of quads) {
          const p = ids.map((d) => c[d]!);
          // no backface culling — the far→near painter's sort handles occlusion
          faces.push({
            z: (p[0]![2] + p[1]![2] + p[2]![2] + p[3]![2]) / 4,
            pts: p.map(([x, y]) => [x, y] as [number, number]),
            fill: shade(rgb, m),
          });
        }
      }
  faces.sort((a, b) => a.z - b.z);
  ctx.clearRect(0, 0, CSS, CSS);
  for (const f of faces) {
    ctx.beginPath();
    f.pts.forEach(([x, y], e) => (e ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.closePath();
    ctx.fillStyle = f.fill;
    ctx.fill();
    ctx.strokeStyle = "rgba(12,13,16,0.5)";
    ctx.lineWidth = 0.75;
    ctx.stroke();
  }
  requestAnimationFrame(draw);
}
requestAnimationFrame(draw);
