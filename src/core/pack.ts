/**
 * rgui core — 一格一物 + 辺界消融 (one-cell-one-thing + boundary dissolution).
 *
 * Rule 1: nodes never overlap. A dragged node that would overlap another is
 * pushed out along the axis of least penetration until the edges are FLUSH —
 * i.e. it snaps onto the neighbor instead of covering it.
 *
 * Rule 2: nodes whose edges are flush render as one fused shape: the shared
 * border segment and any wire between the pair are not drawn. The nodes stay
 * fully standalone (drag one away to split) — this is visual fusion only,
 * distinct from rg-merge (LOD pseudo-node), which moves as a single unit.
 */
import { nodeHeight, type GraphNode } from "./graph.js";

const EPS = 0.01;

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

const rectOf = (n: GraphNode): Rect => ({
  x: n.x,
  y: n.y,
  w: n.w,
  h: nodeHeight(n),
});

/**
 * Resolve overlaps for a node being dragged to (x, y): push it out along the
 * axis of least penetration until it sits flush against whatever it hit.
 * Contact beats grid snap — 一格一物 is the invariant.
 */
export function resolveOverlap(
  node: GraphNode,
  x: number,
  y: number,
  others: GraphNode[],
): { x: number; y: number } {
  const w = node.w;
  const h = nodeHeight(node);
  for (let iter = 0; iter < 8; iter++) {
    let hit: Rect | null = null;
    for (const o of others) {
      if (o === node) continue;
      const r = rectOf(o);
      const penX = Math.min(x + w, r.x + r.w) - Math.max(x, r.x);
      const penY = Math.min(y + h, r.y + r.h) - Math.max(y, r.y);
      if (penX > EPS && penY > EPS) {
        hit = r;
        break;
      }
    }
    if (!hit) break;
    const penX = Math.min(x + w, hit.x + hit.w) - Math.max(x, hit.x);
    const penY = Math.min(y + h, hit.y + hit.h) - Math.max(y, hit.y);
    if (penX < penY) {
      // push horizontally to flush contact
      x += x + w / 2 <= hit.x + hit.w / 2 ? -penX : penX;
    } else {
      y += y + h / 2 <= hit.y + hit.h / 2 ? -penY : penY;
    }
  }
  return { x, y };
}

/** A flush contact segment between two nodes (world coords). */
export interface FlushSegment {
  a: GraphNode;
  b: GraphNode;
  /** "v": shared vertical edge; "h": shared horizontal edge */
  axis: "v" | "h";
  /** the shared edge coordinate (x for "v", y for "h") */
  at: number;
  /** overlap interval along the edge */
  from: number;
  to: number;
}

/**
 * Find every pair of nodes whose edges are flush (touching with overlapping
 * intervals). These boundaries — and wires between the pairs — dissolve.
 */
export function flushSegments(nodes: GraphNode[]): FlushSegment[] {
  const out: FlushSegment[] = [];
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i]!;
      const b = nodes[j]!;
      const ra = rectOf(a);
      const rb = rectOf(b);
      // vertical contact: a.right == b.left or b.right == a.left
      for (const [l, r] of [
        [ra, rb],
        [rb, ra],
      ] as const) {
        if (Math.abs(l.x + l.w - r.x) < EPS) {
          const from = Math.max(l.y, r.y);
          const to = Math.min(l.y + l.h, r.y + r.h);
          if (to - from > EPS)
            out.push({ a, b, axis: "v", at: r.x, from, to });
        }
        if (Math.abs(l.y + l.h - r.y) < EPS) {
          const from = Math.max(l.x, r.x);
          const to = Math.min(l.x + l.w, r.x + r.w);
          if (to - from > EPS)
            out.push({ a, b, axis: "h", at: r.y, from, to });
        }
      }
    }
  }
  return out;
}

/** Set of "idA|idB" (sorted) pairs in flush contact — their wires dissolve. */
export function flushPairKeys(segments: FlushSegment[]): Set<string> {
  const s = new Set<string>();
  for (const seg of segments)
    s.add([seg.a.id, seg.b.id].sort().join("|"));
  return s;
}
