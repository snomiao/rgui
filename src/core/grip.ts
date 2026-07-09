/**
 * Corner-grip gestures. Two ways to make a node bigger, and the rule that
 * lets one held button switch between them:
 *
 * - RESIZE reflows: the footprint changes, the type does not.
 * - RESCALE magnifies: one factor drives w, h and the content scale, so the
 *   aspect ratio is preserved and everything inside grows with the box.
 *
 * Both take the corner the cursor is pointing at, so the caller can keep the
 * grab offset (cursor − corner) and hand over a corner rather than a cursor.
 * Rescale measures its factor against a BASE captured at the last rebase —
 * grip-down, or the moment shift was toggled — which is what makes the two
 * gestures interchangeable mid-drag: each starts from wherever the other
 * left the node, and a rebase is a no-op until the cursor actually moves.
 */
import { sizeStepFor, snapNodeSize, type SizeLaw } from "./grid.js";
import {
  contentScale,
  nodeHeight,
  nodeMinHeight,
  nodeMinWidth,
  type GraphNode,
} from "./graph.js";
import { clampSize } from "./pack.js";
import { DEFAULT_RULE } from "./rule.js";

/** magnification band a rescale may reach */
export const MIN_SCALE = 0.25;
export const MAX_SCALE = 8;

/** a node's geometry, as captured at a rebase */
export interface GripBase {
  w: number;
  h: number;
  scale: number;
}

export type GripSize = GripBase;

const clamp = (v: number, lo: number, hi: number) =>
  Math.min(hi, Math.max(lo, v));

/** the node's geometry right now — the base a rebase would capture */
export function gripBase(n: GraphNode): GripBase {
  return { w: n.w, h: nodeHeight(n), scale: contentScale(n) };
}

/**
 * RESIZE to a corner at world (cx, cy). Grid-snapped, minimums respected,
 * stopped at neighbors. Node-size law: a node spans 1..radix grids at SOME
 * layer — exceeding radix grids promotes it to the next layer, snapped to
 * the limit. The content scale is untouched.
 */
export function gripResize(
  n: GraphNode,
  cx: number,
  cy: number,
  others: GraphNode[],
  radix: number,
  law: SizeLaw = DEFAULT_RULE.sizeLaw,
): GripSize {
  // the two axes snap TOGETHER: the shorter one pulls the longer down
  // toward its layer, as far as the active size law allows
  const snapped = snapNodeSize(cx - n.x, cy - n.y, radix, law);
  const wantW = Math.max(nodeMinWidth(n), snapped.w);
  const wantH = Math.max(nodeMinHeight(n), snapped.h);
  const { w, h } = clampSize(n, wantW, wantH, others);
  return { w, h, scale: contentScale(n) };
}

/**
 * RESCALE to a corner at world (cx, cy), against `base`. The factor is the
 * corner's projection onto the base diagonal: exactly 1 when the corner is
 * the one the base was captured with, so a rebase never moves the node and
 * a drag out and back lands where it began.
 *
 * Only the width lands on the lattice — honoring the ratio means the bottom
 * edge follows from the factor rather than snapping on its own. Neighbors
 * still stop the growth, and whichever axis they stop first governs both.
 */
export function gripRescale(
  n: GraphNode,
  base: GripBase,
  cx: number,
  cy: number,
  others: GraphNode[],
  radix: number,
  law: SizeLaw = DEFAULT_RULE.sizeLaw,
): GripSize {
  const { w: bw, h: bh } = base;
  const dx = cx - n.x;
  const dy = cy - n.y;
  const floor = MIN_SCALE / base.scale;
  let f = (dx * bw + dy * bh) / (bw * bw + bh * bh);
  if (!(f > 0)) f = floor; // corner at or behind the node's origin
  // snap the width to the lattice — unless the law is "per-axis", the
  // height the ratio implies gets a vote on which layer that lattice is
  const step = sizeStepFor(bw * f, bh * f, radix, law);
  f = (Math.max(1, Math.ceil((bw * f) / step - 1e-9)) * step) / bw;
  // a magnified node is still a node: keep it in a sane band
  f = clamp(base.scale * f, MIN_SCALE, MAX_SCALE) / base.scale;
  const { w, h } = clampSize(n, bw * f, bh * f, others);
  f = Math.max(Math.min(w / bw, h / bh), floor);
  return { w: bw * f, h: bh * f, scale: base.scale * f };
}
