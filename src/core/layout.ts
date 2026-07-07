/**
 * rgui core — auto-layout by graph optimization on connections.
 *
 * Layered (Sugiyama-lite) layout: longest-path layering from sources,
 * barycenter ordering to reduce crossings, grid-snapped positions.
 * Pinned nodes keep their positions — the layout flows around them.
 */
import { nodeHeight, type Graph, type GraphNode } from "./graph.js";
import { snap } from "./grid.js";

export interface LayoutOptions {
  /** horizontal gap between layers (world units) */
  gapX?: number;
  /** vertical gap between nodes in a layer (world units) */
  gapY?: number;
  /** grid step to snap positions to */
  gridStep?: number;
  /** layout origin (top-left of the arrangement) */
  origin?: { x: number; y: number };
}

/** Pure: returns new positions for every non-pinned node. */
export function layoutGraph(
  graph: Graph,
  opts: LayoutOptions = {},
): Map<string, { x: number; y: number }> {
  const gapX = opts.gapX ?? 80;
  const gapY = opts.gapY ?? 40;
  const step = opts.gridStep ?? 20;
  const nodes = graph.nodes.filter((n) => !n.pinned);
  const ids = new Set(nodes.map((n) => n.id));
  const byId = new Map(nodes.map((n) => [n.id, n]));

  // edges among layouted nodes only
  const edges = graph.edges.filter(
    (e) => ids.has(e.from.node) && ids.has(e.to.node),
  );

  // --- layering: longest path from sources -------------------------------
  const layerOf = new Map<string, number>();
  const inDeg = new Map<string, number>();
  for (const n of nodes) inDeg.set(n.id, 0);
  for (const e of edges) inDeg.set(e.to.node, (inDeg.get(e.to.node) ?? 0) + 1);
  const queue = nodes.filter((n) => !inDeg.get(n.id)).map((n) => n.id);
  for (const id of queue) layerOf.set(id, 0);
  // Kahn with longest-path relaxation (cycles: leftovers get layer 0)
  const deg = new Map(inDeg);
  while (queue.length) {
    const id = queue.shift()!;
    for (const e of edges) {
      if (e.from.node !== id) continue;
      const l = Math.max(
        layerOf.get(e.to.node) ?? 0,
        (layerOf.get(id) ?? 0) + 1,
      );
      layerOf.set(e.to.node, l);
      const d = (deg.get(e.to.node) ?? 1) - 1;
      deg.set(e.to.node, d);
      if (d === 0) queue.push(e.to.node);
    }
  }
  for (const n of nodes) if (!layerOf.has(n.id)) layerOf.set(n.id, 0);

  // --- group into layers ---------------------------------------------------
  const layerCount = Math.max(...[...layerOf.values()], 0) + 1;
  const layers: GraphNode[][] = Array.from({ length: layerCount }, () => []);
  for (const n of nodes) layers[layerOf.get(n.id)!]!.push(n);

  // --- barycenter ordering (few sweeps) ------------------------------------
  const orderIndex = new Map<string, number>();
  const reindex = (layer: GraphNode[]) =>
    layer.forEach((n, i) => orderIndex.set(n.id, i));
  layers.forEach(reindex);
  for (let sweep = 0; sweep < 4; sweep++) {
    const forward = sweep % 2 === 0;
    for (
      let li = forward ? 1 : layerCount - 2;
      forward ? li < layerCount : li >= 0;
      forward ? li++ : li--
    ) {
      const layer = layers[li]!;
      const bary = new Map<string, number>();
      for (const n of layer) {
        const neigh = edges
          .filter((e) =>
            forward ? e.to.node === n.id : e.from.node === n.id,
          )
          .map((e) => orderIndex.get(forward ? e.from.node : e.to.node) ?? 0);
        bary.set(
          n.id,
          neigh.length
            ? neigh.reduce((a, b) => a + b, 0) / neigh.length
            : (orderIndex.get(n.id) ?? 0),
        );
      }
      layer.sort((a, b) => bary.get(a.id)! - bary.get(b.id)!);
      reindex(layer);
    }
  }

  // --- positions ------------------------------------------------------------
  const origin = opts.origin ?? boundsOrigin(nodes);
  const out = new Map<string, { x: number; y: number }>();
  let x = origin.x;
  for (const layer of layers) {
    const width = Math.max(...layer.map((n) => n.w), 0);
    // center each layer column vertically around the origin row
    const totalH =
      layer.reduce((s, n) => s + nodeHeight(n), 0) +
      gapY * Math.max(0, layer.length - 1);
    let y = origin.y - totalH / 2;
    for (const n of layer) {
      out.set(n.id, { x: snap(x, step), y: snap(y, step) });
      y += nodeHeight(n) + gapY;
    }
    x += width + gapX;
  }
  return out;
}

/** default origin: keep the arrangement roughly where the graph already is */
function boundsOrigin(nodes: GraphNode[]): { x: number; y: number } {
  if (!nodes.length) return { x: 0, y: 0 };
  const x = Math.min(...nodes.map((n) => n.x));
  const cy =
    nodes.reduce((s, n) => s + n.y + nodeHeight(n) / 2, 0) / nodes.length;
  return { x, y: cy };
}
