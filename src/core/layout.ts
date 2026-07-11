/**
 * rgui core — auto-layout by graph optimization on connections.
 *
 * Layered (Sugiyama-lite) layout: longest-path layering from sources,
 * barycenter ordering to reduce crossings, grid-snapped positions.
 * Pinned nodes keep their positions — the layout flows around them.
 */
import { nodeHeight, nodeMinWidth, type Graph, type GraphNode } from "./graph.js";
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

export interface DenseLayoutOptions {
  /** Main-grid step. Every returned coordinate and size is a multiple of it. */
  gridStep?: number;
  /** Empty main-grid cells between non-contracted blocks (default 1). */
  gapCells?: number;
  /** Deterministic barycentric relaxation passes (default 8). */
  relaxationPasses?: number;
  /** Snapped top-left origin of the arrangement. */
  origin?: { x: number; y: number };
}

export interface DenseLayoutRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface DenseLayoutResult {
  /** Snapped geometry for every graph node; applying it is host-owned. */
  nodes: Map<string, DenseLayoutRect>;
  /** Maximal direct chains, including singleton blocks, in deterministic order. */
  chains: string[][];
}

interface DenseBlock {
  id: string;
  members: string[];
  w: number;
  h: number;
}

/**
 * Dense, deterministic workflow layout.
 *
 * A directed A→B edge contracts iff A has exactly one distinct outgoing
 * graph neighbor (B) and B has exactly one distinct incoming graph neighbor
 * (A). A may have incoming edges and B may have outgoing edges, so the rule
 * builds maximal direct chains while every fan-in/fan-out boundary remains
 * separated by at least one main-grid cell. Parallel port edges do not alter
 * the distinct-neighbor degree. Cycles have no valid all-left-to-right layout;
 * a cycle is cut deterministically at its lexicographically smallest member.
 *
 * Pure: sizes are snapped upward, positions are snapped, and returned boxes
 * never overlap (contracted neighbors may touch flush at an edge).
 */
export function layoutDenseGraph(
  graph: Graph,
  opts: DenseLayoutOptions = {},
): DenseLayoutResult {
  const step = Math.max(Number.EPSILON, opts.gridStep ?? 20);
  const gap = Math.max(step, Math.ceil((opts.gapCells ?? 1)) * step);
  const passes = Math.max(0, Math.floor(opts.relaxationPasses ?? 8));
  const sortedNodes = [...graph.nodes].sort((a, b) => a.id.localeCompare(b.id));
  const byId = new Map(sortedNodes.map((n) => [n.id, n]));
  const ids = new Set(byId.keys());
  const out = new Map<string, Set<string>>();
  const incoming = new Map<string, Set<string>>();
  for (const id of ids) {
    out.set(id, new Set());
    incoming.set(id, new Set());
  }
  for (const edge of graph.edges) {
    const a = edge.from.node;
    const b = edge.to.node;
    if (a === b || !ids.has(a) || !ids.has(b)) continue;
    out.get(a)!.add(b);
    incoming.get(b)!.add(a);
  }

  const successor = new Map<string, string>();
  const predecessor = new Map<string, string>();
  for (const a of ids) {
    const outs = [...out.get(a)!];
    if (outs.length !== 1) continue;
    const b = outs[0]!;
    const ins = [...incoming.get(b)!];
    if (ins.length === 1 && ins[0] === a) {
      successor.set(a, b);
      predecessor.set(b, a);
    }
  }

  const chains: string[][] = [];
  const visited = new Set<string>();
  const consume = (start: string) => {
    if (visited.has(start)) return;
    const chain: string[] = [];
    let id: string | undefined = start;
    while (id !== undefined && !visited.has(id)) {
      visited.add(id);
      chain.push(id);
      id = successor.get(id);
    }
    chains.push(chain);
  };
  for (const id of ids) if (!predecessor.has(id)) consume(id);
  // Remaining nodes are pure directed cycles; sortedNodes makes the cut stable.
  for (const id of ids) consume(id);

  const ceilStep = (value: number) => Math.max(step, Math.ceil(value / step) * step);
  const size = new Map<string, { w: number; h: number }>();
  for (const node of sortedNodes) {
    size.set(node.id, {
      w: ceilStep(Math.max(node.w, nodeMinWidth(node))),
      h: ceilStep(nodeHeight(node)),
    });
  }
  const blocks: DenseBlock[] = chains.map((members) => ({
    id: members[0]!,
    members,
    w: members.reduce((sum, id) => sum + size.get(id)!.w, 0),
    h: Math.max(...members.map((id) => size.get(id)!.h)),
  }));
  const blockOf = new Map<string, DenseBlock>();
  for (const block of blocks) for (const id of block.members) blockOf.set(id, block);

  const blockOut = new Map(blocks.map((b) => [b.id, new Set<string>()]));
  const blockIn = new Map(blocks.map((b) => [b.id, new Set<string>()]));
  for (const [a, targets] of out) {
    const ba = blockOf.get(a)!;
    for (const target of targets) {
      const bb = blockOf.get(target)!;
      if (ba === bb) continue;
      blockOut.get(ba.id)!.add(bb.id);
      blockIn.get(bb.id)!.add(ba.id);
    }
  }

  // Longest-path layers guarantee upstream-left/downstream-right for DAGs.
  const layer = new Map(blocks.map((b) => [b.id, 0]));
  const indegree = new Map(blocks.map((b) => [b.id, blockIn.get(b.id)!.size]));
  const queue = blocks.filter((b) => indegree.get(b.id) === 0).map((b) => b.id).sort();
  while (queue.length) {
    const id = queue.shift()!;
    for (const next of [...blockOut.get(id)!].sort()) {
      layer.set(next, Math.max(layer.get(next)!, layer.get(id)! + 1));
      indegree.set(next, indegree.get(next)! - 1);
      if (indegree.get(next) === 0) {
        queue.push(next);
        queue.sort();
      }
    }
  }
  const layerCount = Math.max(0, ...layer.values()) + 1;
  const layers: DenseBlock[][] = Array.from({ length: layerCount }, () => []);
  for (const block of blocks) layers[layer.get(block.id)!]!.push(block);
  for (const list of layers) list.sort((a, b) => a.id.localeCompare(b.id));

  // Deterministic constrained relaxation: repeated barycentric ordering
  // shortens wires, then hard packing below restores gaps and zero overlap.
  const order = new Map<string, number>();
  const reindex = () => layers.forEach((list) => list.forEach((b, i) => order.set(b.id, i)));
  reindex();
  for (let pass = 0; pass < passes; pass++) {
    const forward = pass % 2 === 0;
    const start = forward ? 1 : layerCount - 2;
    const stop = forward ? layerCount : -1;
    for (let li = start; li !== stop; li += forward ? 1 : -1) {
      const list = layers[li]!;
      const score = (block: DenseBlock) => {
        const neighbors = [...(forward ? blockIn.get(block.id)! : blockOut.get(block.id)!)];
        if (!neighbors.length) return order.get(block.id) ?? 0;
        return neighbors.reduce((sum, id) => sum + (order.get(id) ?? 0), 0) / neighbors.length;
      };
      list.sort((a, b) => score(a) - score(b) || a.id.localeCompare(b.id));
      reindex();
    }
  }

  const origin = opts.origin ?? boundsOrigin(sortedNodes);
  let x = snap(origin.x, step);
  const blockPos = new Map<string, { x: number; y: number }>();
  for (const list of layers) {
    const layerW = Math.max(step, ...list.map((b) => b.w));
    let y = snap(origin.y, step);
    for (const block of list) {
      blockPos.set(block.id, { x, y });
      y += block.h + gap;
    }
    x += layerW + gap;
  }

  const result = new Map<string, DenseLayoutRect>();
  for (const block of blocks) {
    const pos = blockPos.get(block.id)!;
    let memberX = pos.x;
    for (const id of block.members) {
      const s = size.get(id)!;
      result.set(id, { x: memberX, y: pos.y, w: s.w, h: s.h });
      memberX += s.w;
    }
  }
  return { nodes: result, chains: blocks.map((b) => [...b.members]) };
}
