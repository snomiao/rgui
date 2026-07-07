/**
 * rgui core — semantic-zoom LOD (level of detail).
 *
 * Render rule: readability is a SCREEN-space property. Whatever an element's
 * world size is, at the current viewer scale it must either be drawn readable
 * or be replaced by a readable abstraction.
 *
 * When a group of sibling nodes falls below the readability threshold, the
 * group collapses into one pseudo-node drawn at constant screen size, showing
 * only the group's OPEN ports (ports wired across the group boundary, or
 * unconnected). Internal wires are hidden; boundary wires reroute to the
 * pseudo-node's ports.
 */
import {
  inputPortPos,
  nodeHeight,
  outputPortPos,
  type Graph,
  type GraphNode,
  type Port,
} from "./graph.js";
import { DEFAULT_RULE, type RgRule } from "./rule.js";

export interface PseudoNode {
  id: string; // group name, or node id for a singleton
  title: string;
  /** world center of the member bounding box (may be shifted by declutter) */
  cx: number;
  cy: number;
  members: GraphNode[];
  inputs: Port[];
  outputs: Port[];
  /** set for singleton pseudo-nodes (an unreadable ungrouped node) */
  category?: GraphNode["category"];
}

export type EndpointRef =
  | { at: "node"; node: GraphNode; side: "in" | "out"; index: number }
  | { at: "pseudo"; pseudo: PseudoNode; side: "in" | "out"; index: number };

export interface RenderEdge {
  from: EndpointRef;
  to: EndpointRef;
  kind: Port["kind"];
  dashed?: boolean;
}

export interface RenderGraph {
  nodes: GraphNode[];
  pseudo: PseudoNode[];
  edges: RenderEdge[];
}

/** pseudo-node rect in world units at scale k (screen-constant size) */
export function pseudoRect(p: PseudoNode, k: number, rule = DEFAULT_RULE) {
  const m = rule.pseudo;
  const rows = Math.max(p.inputs.length, p.outputs.length, 1);
  const hpx = m.headerH + m.pad + rows * m.rowH + m.pad;
  const w = m.w / k;
  const h = hpx / k;
  return { x: p.cx - w / 2, y: p.cy - h / 2, w, h };
}

export function pseudoPortPos(
  p: PseudoNode,
  side: "in" | "out",
  i: number,
  k: number,
  rule = DEFAULT_RULE,
): [number, number] {
  const m = rule.pseudo;
  const r = pseudoRect(p, k, rule);
  const y = r.y + (m.headerH + m.pad + (i + 0.5) * m.rowH) / k;
  return [side === "in" ? r.x : r.x + r.w, y];
}

export function endpointPos(
  ref: EndpointRef,
  k: number,
  rule = DEFAULT_RULE,
): [number, number] {
  if (ref.at === "node") {
    return ref.side === "in"
      ? inputPortPos(ref.node, ref.index)
      : outputPortPos(ref.node, ref.index);
  }
  return pseudoPortPos(ref.pseudo, ref.side, ref.index, k, rule);
}

/** shortest screen-space gap between two node rects (0 if overlapping) */
function rectGapPx(a: GraphNode, b: GraphNode, k: number): number {
  const gx = Math.max(
    0,
    Math.max(a.x, b.x) - Math.min(a.x + a.w, b.x + b.w),
  );
  const gy = Math.max(
    0,
    Math.max(a.y, b.y) - Math.min(a.y + nodeHeight(a), b.y + nodeHeight(b)),
  );
  return Math.hypot(gx, gy) * k;
}

/** Build the LOD render graph for the current viewer scale. */
export function buildRenderGraph(
  graph: Graph,
  k: number,
  rule: RgRule = DEFAULT_RULE,
): RenderGraph {
  // the render rule applies to EVERY element: nodes that would render
  // unreadably small degrade into readable pseudo-nodes
  const unreadable = graph.nodes.filter(
    (n) => nodeHeight(n) * k < rule.collapsePx,
  );

  // high-order rg nodes emerge from location + connection logic:
  // union-find, merging pairs that are near on screen — nearness budget is
  // larger when the pair is wired together
  const parent = new Map<string, string>();
  const find = (id: string): string => {
    const p = parent.get(id) ?? id;
    if (p === id) return id;
    const r = find(p);
    parent.set(id, r);
    return r;
  };
  const union = (a: string, b: string) => parent.set(find(a), find(b));

  const connected = new Set<string>(); // "idA|idB" sorted
  for (const e of graph.edges) {
    const [a, b] = [e.from.node, e.to.node].sort();
    connected.add(`${a}|${b}`);
  }

  for (let i = 0; i < unreadable.length; i++) {
    for (let j = i + 1; j < unreadable.length; j++) {
      const a = unreadable[i]!;
      const b = unreadable[j]!;
      const wired = connected.has([a.id, b.id].sort().join("|"));
      const budget = wired ? rule.clusterGapConnectedPx : rule.clusterGapPx;
      if (rectGapPx(a, b, k) < budget) union(a.id, b.id);
    }
  }

  // materialize clusters as pseudo-nodes (singletons become title chips)
  const clusters = new Map<string, GraphNode[]>();
  for (const n of unreadable) {
    const root = find(n.id);
    let c = clusters.get(root);
    if (!c) clusters.set(root, (c = []));
    c.push(n);
  }
  const nodeToPseudo = new Map<string, PseudoNode>();
  const collapsed: PseudoNode[] = [];
  for (const members of clusters.values()) {
    const xs = members.flatMap((n) => [n.x, n.x + n.w]);
    const ys = members.flatMap((n) => [n.y, n.y + nodeHeight(n)]);
    const solo = members.length === 1;
    const p: PseudoNode = {
      id: members.map((n) => n.id).join("+"),
      title: solo
        ? members[0]!.title
        : `${members[0]!.title} +${members.length - 1}`,
      cx: (Math.min(...xs) + Math.max(...xs)) / 2,
      cy: (Math.min(...ys) + Math.max(...ys)) / 2,
      members,
      inputs: [],
      outputs: [],
      category: solo ? members[0]!.category : undefined,
    };
    collapsed.push(p);
    for (const n of members) nodeToPseudo.set(n.id, p);
  }

  const byId = new Map(graph.nodes.map((n) => [n.id, n]));

  // mark connected ports so we can also expose unconnected (open) ones
  const wired = new Set<string>(); // "nodeId/in|out/portId"
  for (const e of graph.edges) {
    wired.add(`${e.from.node}/out/${e.from.port}`);
    wired.add(`${e.to.node}/in/${e.to.port}`);
  }

  // open ports of collapsed groups (dedup by label+kind, stable order)
  const pseudoPortIndex = new Map<string, number>(); // "group/side/label+kind" -> row
  const openPort = (p: PseudoNode, side: "in" | "out", port: Port): number => {
    const key = `${p.id}/${side}/${port.label}·${port.kind}`;
    let idx = pseudoPortIndex.get(key);
    if (idx === undefined) {
      const list = side === "in" ? p.inputs : p.outputs;
      idx = list.length;
      list.push(port);
      pseudoPortIndex.set(key, idx);
    }
    return idx;
  };

  // boundary edges reroute; internal edges vanish
  const edges: RenderEdge[] = [];
  for (const e of graph.edges) {
    const a = byId.get(e.from.node);
    const b = byId.get(e.to.node);
    if (!a || !b) continue;
    const pa = nodeToPseudo.get(a.id);
    const pb = nodeToPseudo.get(b.id);
    if (pa && pb && pa === pb) continue; // internal to one group
    const oi = a.outputs.findIndex((p) => p.id === e.from.port);
    const ii = b.inputs.findIndex((p) => p.id === e.to.port);
    if (oi < 0 || ii < 0) continue;
    const from: EndpointRef = pa
      ? { at: "pseudo", pseudo: pa, side: "out", index: openPort(pa, "out", a.outputs[oi]!) }
      : { at: "node", node: a, side: "out", index: oi };
    const to: EndpointRef = pb
      ? { at: "pseudo", pseudo: pb, side: "in", index: openPort(pb, "in", b.inputs[ii]!) }
      : { at: "node", node: b, side: "in", index: ii };
    edges.push({ from, to, kind: a.outputs[oi]!.kind, dashed: e.dashed });
  }

  // unconnected ports of members are open too — expose them on the pseudo
  for (const p of collapsed.values()) {
    for (const n of p.members) {
      n.inputs.forEach((port) => {
        if (!wired.has(`${n.id}/in/${port.id}`)) openPort(p, "in", port);
      });
      n.outputs.forEach((port) => {
        if (!wired.has(`${n.id}/out/${port.id}`)) openPort(p, "out", port);
      });
    }
  }

  const pseudo = collapsed;
  declutter(pseudo, k, rule);

  return {
    nodes: graph.nodes.filter((n) => !nodeToPseudo.has(n.id)),
    pseudo,
    edges,
  };
}

/**
 * Screen-constant pseudo-nodes can collide when their world anchors are
 * close. Push overlapping pairs apart along the axis of least overlap
 * (in screen space) until stable — keeps the collapsed view readable.
 */
function declutter(pseudo: PseudoNode[], k: number, rule: RgRule) {
  const margin = rule.declutterMarginPx / k;
  for (let iter = 0; iter < 10; iter++) {
    let moved = false;
    for (let i = 0; i < pseudo.length; i++) {
      for (let j = i + 1; j < pseudo.length; j++) {
        const a = pseudo[i]!;
        const b = pseudo[j]!;
        const ra = pseudoRect(a, k, rule);
        const rb = pseudoRect(b, k, rule);
        const ox =
          Math.min(ra.x + ra.w, rb.x + rb.w) - Math.max(ra.x, rb.x) + margin;
        const oy =
          Math.min(ra.y + ra.h, rb.y + rb.h) - Math.max(ra.y, rb.y) + margin;
        if (ox <= margin || oy <= margin) continue;
        moved = true;
        if (ox < oy) {
          const s = a.cx <= b.cx ? 1 : -1;
          a.cx -= (s * ox) / 2;
          b.cx += (s * ox) / 2;
        } else {
          const s = a.cy <= b.cy ? 1 : -1;
          a.cy -= (s * oy) / 2;
          b.cy += (s * oy) / 2;
        }
      }
    }
    if (!moved) break;
  }
}
