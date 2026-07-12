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
  type Edge,
  type Graph,
  type GraphNode,
  type Port,
} from "./graph.js";
import { flushSegments } from "./pack.js";
import { gridLevels, sizeLayerStep, snap, snapSizeRadix } from "./grid.js";
import { DEFAULT_RULE, type RgRule } from "./rule.js";

export interface PseudoNode {
  id: string; // group name, or node id for a singleton
  title: string;
  /** world center of the member bounding box (may be shifted by declutter) */
  cx: number;
  cy: number;
  /** world size of the member ENCLOSURE (the merged block occupies the
   * footprint of what it replaced, clamped to a readable minimum) */
  bw: number;
  bh: number;
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
  /** the original graph edge this render edge represents */
  source: Edge;
}

export interface RenderGraph {
  nodes: GraphNode[];
  pseudo: PseudoNode[];
  edges: RenderEdge[];
}

/**
 * pseudo-node rect in world units at scale k: the members' enclosure,
 * never smaller than the readable minimum (screen px)
 */
export function pseudoRect(p: PseudoNode, k: number, rule = DEFAULT_RULE) {
  const m = rule.pseudo;
  const rows = Math.max(p.inputs.length, p.outputs.length, 1);
  const minHpx = m.headerH + m.pad + rows * m.rowH + m.pad;
  // merged blocks obey the node-size law too: the enclosure (clamped to
  // the readable minimum) rounds UP to an integer 1..radix grids at its
  // own scale layer — RG nodes are grid citizens in size, not just position
  const w = snapSizeRadix(Math.max(p.bw, m.w / k), rule.radix);
  const h = snapSizeRadix(Math.max(p.bh, minHpx / k), rule.radix);
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
function rectGapView(
  a: GraphNode,
  b: GraphNode,
  px: (gx: number, gy: number) => number,
): number {
  const gx = Math.max(
    0,
    Math.max(a.x, b.x) - Math.min(a.x + a.w, b.x + b.w),
  );
  const gy = Math.max(
    0,
    Math.max(a.y, b.y) - Math.min(a.y + nodeHeight(a), b.y + nodeHeight(b)),
  );
  return px(gx, gy);
}

/** Build the LOD render graph for the current viewer scale. */
export function buildRenderGraph(
  graph: Graph,
  k: number,
  rule: RgRule = DEFAULT_RULE,
  /**
   * screen linear map applied AFTER k (viewport 3-D rotation): apparent
   * sizes/gaps shrink under foreshortening, so visually converging nodes
   * merge — a pure rendering trick, base positions never change
   */
  xform?: readonly [number, number, number, number],
  /**
   * RG MONOTONICITY: memberships carried from the previous (finer) scale —
   * while zooming out, an already-merged block never releases its children.
   * Pass pairs from the last build's pseudo members when k decreased;
   * omit when zooming in so blocks re-expand.
   */
  carry?: readonly [string, string][],
): RenderGraph {
  const [xa, xb, xc, xd] = xform ?? [1, 0, 0, 1];
  /** screen length of a world vector under the full view map */
  const px = (gx: number, gy: number) =>
    Math.hypot(xa * gx + xb * gy, xc * gx + xd * gy) * k;
  const kH = Math.hypot(xb, xd) * k; // apparent vertical scale
  // CONTAINMENT: declared hierarchy scopes the emergent merging — nodes
  // merge by location/connection only WITHIN their container (a team's
  // members merge into the team, never into the neighboring team), and a
  // container absorbs its children once they all fall below readability.
  const nodeById = new Map(graph.nodes.map((n) => [n.id, n]));
  const parentOf = new Map<string, string>();
  const childIds = new Map<string, string[]>();
  for (const n of graph.nodes)
    if (n.parent && nodeById.has(n.parent)) {
      parentOf.set(n.id, n.parent);
      let c = childIds.get(n.parent);
      if (!c) childIds.set(n.parent, (c = []));
      c.push(n.id);
    }
  const scope = (id: string) => parentOf.get(id) ?? "";
  const isAncestor = (a: string, b: string): boolean => {
    for (let c = parentOf.get(b); c; c = parentOf.get(c)) if (c === a) return true;
    return false;
  };
  const depthOf = (id: string) => {
    let d = 0;
    for (let c = parentOf.get(id); c; c = parentOf.get(c)) d++;
    return d;
  };
  // A container that absorbed its children HOLDS ITS LEVEL: it stays one
  // block and refuses horizontal merges until its OWN frame is unreadable.
  // Without this, absorption and the next-level merge fire in the same
  // build (all siblings share one scope), so the intermediate blocks the
  // hierarchy promises ("teams before the company") never render.
  const holdsLevel = (id: string): boolean => {
    if (!childIds.has(id)) return false;
    const n = nodeById.get(id);
    return !!n && nodeHeight(n) * kH >= rule.collapsePx;
  };
  /** a block lives in the scope of its outermost member — an absorbed
   * team block acts at the level of the team node, not its people */
  const pseudoScope = (p: PseudoNode): string => {
    let best = p.members[0]!;
    let bd = depthOf(best.id);
    for (const m of p.members) {
      const d = depthOf(m.id);
      if (d < bd) {
        bd = d;
        best = m;
      }
    }
    return scope(best.id);
  };
  // SNAP BEATS LOCATION, and stacks RG TOGETHER: when ANY member of a
  // flush-contact stack crosses the (more generous) collapseSnappedPx
  // threshold, the WHOLE stack promotes to the next level as one — no
  // partially-merged stacks
  const segments = flushSegments(graph.nodes);
  const stackRoot = new Map<string, string>();
  const findRoot = (id: string): string => {
    const p = stackRoot.get(id) ?? id;
    if (p === id) return id;
    const r = findRoot(p);
    stackRoot.set(id, r);
    return r;
  };
  for (const seg of segments)
    if (scope(seg.a.id) === scope(seg.b.id))
      stackRoot.set(findRoot(seg.a.id), findRoot(seg.b.id));
  const stacks = new Map<string, GraphNode[]>();
  for (const n of graph.nodes) {
    if (!stackRoot.has(n.id) && !segments.some((s0) => s0.a === n || s0.b === n))
      continue;
    const root = findRoot(n.id);
    let g = stacks.get(root);
    if (!g) stacks.set(root, (g = []));
    g.push(n);
  }
  const collapseIds = new Set<string>();
  for (const members of stacks.values())
    if (
      members.some((n) => nodeHeight(n) * kH < rule.collapseSnappedPx)
    )
      for (const n of members) collapseIds.add(n.id);
  // the render rule applies to EVERY element: nodes that would render
  // unreadably small degrade into readable pseudo-nodes
  const unreadable = graph.nodes.filter(
    (n) => collapseIds.has(n.id) || nodeHeight(n) * kH < rule.collapsePx,
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

  // CASCADING RG: if a merged block ends up overlapping other nodes or
  // blocks, they RG together — rebuild with forced unions until stable
  const extraEligible = new Set<string>();
  const forcedPairs: [string, string][] = [];
  for (let rgIter = 0; ; rgIter++) {
  parent.clear();
  const eligible = new Set([
    ...unreadable.map((n) => n.id),
    ...extraEligible,
  ]);
  // CONTAINER ABSORPTION: once every child of a container is below
  // readability, the container joins them and the whole subtree becomes
  // one block titled by the container. Nested levels stay distinct: a
  // child that is ITSELF a container only counts once its own frame is
  // unreadable — teams collapse into team blocks long before the company
  // collapses into one company block (hierarchy levels ARE the RG levels)
  for (let grew = true; grew; ) {
    grew = false;
    for (const [cid, kids] of childIds) {
      if (eligible.has(cid)) continue;
      const ready = kids.every(
        (id) =>
          eligible.has(id) &&
          (!childIds.has(id) ||
            nodeHeight(nodeById.get(id)!) * kH < rule.collapsePx),
      );
      if (ready) {
        eligible.add(cid);
        grew = true;
      }
    }
  }
  for (const [cid, kids] of childIds)
    if (eligible.has(cid))
      for (const id of kids) if (eligible.has(id)) union(cid, id);
  for (const [a, b] of forcedPairs)
    if (eligible.has(a) && eligible.has(b)) union(a, b);
  // carried memberships from the finer scale (zoom-out hysteresis)
  if (carry)
    for (const [a, b] of carry)
      if (eligible.has(a) && eligible.has(b)) union(a, b);
  // 1) flush contact unions FIRST and unconditionally (snap > location) —
  // within one containment scope only: frames keep their contents
  for (const seg of segments)
    if (
      eligible.has(seg.a.id) &&
      eligible.has(seg.b.id) &&
      scope(seg.a.id) === scope(seg.b.id) &&
      !holdsLevel(seg.a.id) &&
      !holdsLevel(seg.b.id)
    )
      union(seg.a.id, seg.b.id);
  // 1.5) CHAIN CONTRACTION: interior nodes of a linear chain (in-degree 1,
  // out-degree 1) union unconditionally when unreadable — the chain's
  // endpoints stay as real nodes and the middle becomes one compact link:
  // A → [⋯ ×3] → E. Chain beats distance, like snap beats location.
  const inDeg = new Map<string, number>();
  const outDeg = new Map<string, number>();
  for (const e of graph.edges) {
    outDeg.set(e.from.node, (outDeg.get(e.from.node) ?? 0) + 1);
    inDeg.set(e.to.node, (inDeg.get(e.to.node) ?? 0) + 1);
  }
  const isMiddle = (id: string) =>
    inDeg.get(id) === 1 && outDeg.get(id) === 1;
  for (const e of graph.edges)
    if (
      isMiddle(e.from.node) &&
      isMiddle(e.to.node) &&
      eligible.has(e.from.node) &&
      eligible.has(e.to.node) &&
      scope(e.from.node) === scope(e.to.node) &&
      !holdsLevel(e.from.node) &&
      !holdsLevel(e.to.node)
    )
      union(e.from.node, e.to.node);
  // 2) then proximity/connection with their pixel budgets
  const elig = graph.nodes.filter((n) => eligible.has(n.id));
  for (let i = 0; i < elig.length; i++) {
    for (let j = i + 1; j < elig.length; j++) {
      const a = elig[i]!;
      const b = elig[j]!;
      if (scope(a.id) !== scope(b.id)) continue; // merge within scope only
      if (holdsLevel(a.id) || holdsLevel(b.id)) continue; // blocks hold their level
      const wired = connected.has([a.id, b.id].sort().join("|"));
      const budget = wired ? rule.clusterGapConnectedPx : rule.clusterGapPx;
      if (rectGapView(a, b, px) < budget) union(a.id, b.id);
    }
  }

  // FLOW ORDER: pseudo members sort topologically (Kahn over the edges),
  // so titles and "A → B → C" summaries always read in data direction —
  // never in node insertion order
  const topoIndex = new Map<string, number>();
  {
    const indeg = new Map<string, number>();
    for (const n of graph.nodes) indeg.set(n.id, 0);
    for (const e of graph.edges)
      indeg.set(e.to.node, (indeg.get(e.to.node) ?? 0) + 1);
    const q = graph.nodes.filter((n) => !indeg.get(n.id)).map((n) => n.id);
    let idx = 0;
    while (q.length) {
      const id = q.shift()!;
      topoIndex.set(id, idx++);
      for (const e of graph.edges) {
        if (e.from.node !== id) continue;
        const d = (indeg.get(e.to.node) ?? 1) - 1;
        indeg.set(e.to.node, d);
        if (d === 0) q.push(e.to.node);
      }
    }
    for (const n of graph.nodes)
      if (!topoIndex.has(n.id)) topoIndex.set(n.id, idx++);
  }

  // materialize clusters as pseudo-nodes (singletons become title chips)
  const clusters = new Map<string, GraphNode[]>();
  for (const n of elig) {
    const root = find(n.id);
    let c = clusters.get(root);
    if (!c) clusters.set(root, (c = []));
    c.push(n);
  }
  const nodeToPseudo = new Map<string, PseudoNode>();
  const collapsed: PseudoNode[] = [];
  for (const members of clusters.values()) {
    members.sort(
      (a, b) => (topoIndex.get(a.id) ?? 0) - (topoIndex.get(b.id) ?? 0),
    );
    const xs = members.flatMap((n) => [n.x, n.x + n.w]);
    const ys = members.flatMap((n) => [n.y, n.y + nodeHeight(n)]);
    const solo = members.length === 1;
    const isChainRun =
      members.length > 1 && members.every((n) => isMiddle(n.id));
    // a container NAMES the block only when it accounts for the WHOLE
    // cluster (every member is the container or its descendant) — the
    // outermost one wins ("Engineering", not "Aoi (EM) +3"). A cluster
    // that also swallowed outsiders must not wear the container's name;
    // it falls back to the count title.
    const idsIn = new Set(members.map((n) => n.id));
    const owners = members.filter((n) => {
      const kids = childIds.get(n.id);
      if (!kids || !kids.every((id) => idsIn.has(id))) return false;
      return members.every((m) => m === n || isAncestor(n.id, m.id));
    });
    const outermost = owners.filter(
      (o) => !owners.some((q) => q !== o && isAncestor(q.id, o.id)),
    );
    const owner = outermost.length === 1 ? outermost[0] : undefined;
    const p: PseudoNode = {
      id: members.map((n) => n.id).join("+"),
      title: owner
        ? owner.title
        : solo
          ? members[0]!.title
          : isChainRun
            ? `⋯ ×${members.length}`
            : `${members[0]!.title} +${members.length - 1}`,
      cx: (Math.min(...xs) + Math.max(...xs)) / 2,
      cy: (Math.min(...ys) + Math.max(...ys)) / 2,
      bw: Math.max(...xs) - Math.min(...xs),
      bh: Math.max(...ys) - Math.min(...ys),
      members,
      inputs: [],
      outputs: [],
      category: owner?.category ?? (solo ? members[0]!.category : undefined),
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
    edges.push({
      from,
      to,
      kind: a.outputs[oi]!.kind,
      dashed: e.dashed,
      source: e,
    });
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
  // higher-order nodes sit on the higher-order lattice: snap each merged
  // box to the CURRENT main grid step (declutter afterwards — contact
  // beats grid, exactly like drags)
  const mainStep = gridLevels(k, rule.minGridPx, rule.radix)[0]!.step;
  for (const p of pseudo) {
    const r = pseudoRect(p, k, rule);
    // a merged block quantizes per axis to the finer of the view grid and
    // its own size layer on that axis
    const psx = Math.min(mainStep, sizeLayerStep(r.w, rule.radix));
    const psy = Math.min(mainStep, sizeLayerStep(r.h, rule.radix));
    p.cx += snap(r.x, psx) - r.x;
    p.cy += snap(r.y, psy) - r.y;
  }
  const expanded = graph.nodes.filter((n) => !nodeToPseudo.has(n.id));

  // overlap after RG? → RG together (fixed point, bounded iterations)
  if (rgIter < 4) {
    let changed = false;
    const rects = pseudo.map((p) => ({ p, r: pseudoRect(p, k, rule) }));
    const hits = (
      a: { x: number; y: number; w: number; h: number },
      b: { x: number; y: number; w: number; h: number },
    ) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
    for (let i = 0; i < rects.length; i++) {
      for (let j = i + 1; j < rects.length; j++) {
        // colliding blocks merge only WITHIN one containment scope —
        // across scopes declutter pushes them apart instead, so the
        // hierarchy's abstractions never bleed into each other
        if (pseudoScope(rects[i]!.p) !== pseudoScope(rects[j]!.p)) continue;
        // a block holding its level declutters away instead of merging
        if (
          rects[i]!.p.members.some((m) => holdsLevel(m.id)) ||
          rects[j]!.p.members.some((m) => holdsLevel(m.id))
        )
          continue;
        if (hits(rects[i]!.r, rects[j]!.r)) {
          forcedPairs.push([
            rects[i]!.p.members[0]!.id,
            rects[j]!.p.members[0]!.id,
          ]);
          changed = true;
        }
      }
      for (const n of expanded) {
        // a block INSIDE its own container frame is sanctioned overlap —
        // that's containment, not a collision
        if (rects[i]!.p.members.every((m) => isAncestor(n.id, m.id))) continue;
        if (scope(n.id) !== pseudoScope(rects[i]!.p)) continue;
        // a still-readable container frame never gets pulled into a block —
        // declutter pushes the block out of it instead
        if (holdsLevel(n.id) || rects[i]!.p.members.some((m) => holdsLevel(m.id)))
          continue;
        const nr = { x: n.x, y: n.y, w: n.w, h: nodeHeight(n) };
        if (hits(rects[i]!.r, nr)) {
          extraEligible.add(n.id);
          forcedPairs.push([n.id, rects[i]!.p.members[0]!.id]);
          changed = true;
        }
      }
    }
    if (changed) continue; // rebuild with the new unions
  }

  declutter(pseudo, k, rule, expanded, isAncestor);

  return {
    nodes: expanded,
    pseudo,
    edges,
  };
  } // cascading-RG loop
}

/**
 * Screen-constant pseudo-nodes can collide when their world anchors are
 * close. Push overlapping pairs apart along the axis of least overlap
 * (in screen space) until stable — keeps the collapsed view readable.
 */
function declutter(
  pseudo: PseudoNode[],
  k: number,
  rule: RgRule,
  obstacles: GraphNode[] = [],
  isAncestor?: (a: string, b: string) => boolean,
) {
  const margin = rule.declutterMarginPx / k;
  for (let iter = 0; iter < 10; iter++) {
    let moved = false;
    // expanded (readable) nodes are immovable: push pseudos out of them
    for (const p of pseudo) {
      const r = pseudoRect(p, k, rule);
      for (const o of obstacles) {
        // a block stays INSIDE its own container frame — never pushed out
        if (isAncestor && p.members.every((m) => isAncestor(o.id, m.id)))
          continue;
        const oh = nodeHeight(o);
        const ox =
          Math.min(r.x + r.w, o.x + o.w) - Math.max(r.x, o.x) + margin;
        const oy =
          Math.min(r.y + r.h, o.y + oh) - Math.max(r.y, o.y) + margin;
        if (ox <= margin || oy <= margin) continue;
        moved = true;
        if (ox < oy)
          p.cx += (p.cx <= o.x + o.w / 2 ? -1 : 1) * ox;
        else p.cy += (p.cy <= o.y + oh / 2 ? -1 : 1) * oy;
      }
    }
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
