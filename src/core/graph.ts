/**
 * rgui core — node-graph model (framework-agnostic, world coordinates).
 * Bitwig The Grid-style: compact modules with a colored category header,
 * input ports on the left edge, output ports on the right edge.
 */

/**
 * Signal kinds are OPEN: the built-ins get hand-picked colors, any other
 * string gets a stable derived color — rgui renders any domain's graph
 * (media pipelines, org charts, dependency graphs) without registration.
 */
export type SignalKind = "image" | "audio" | "text" | "ctl" | (string & {});

export type NodeCategory = "source" | "model" | "sink" | (string & {});

/**
 * Which way data runs THROUGH a node: "ltr" (default) reads inputs on the
 * left edge and outputs on the right, "ttb" runs top-to-bottom, and the
 * reversed pair mirror them. Flow is per-node, so a right-to-left sink can
 * sit in a left-to-right pipeline and still present its ports to the wire.
 */
export type Flow = "ltr" | "rtl" | "ttb" | "btt";

/** an edge of a node's rect */
export type Side = "top" | "right" | "bottom" | "left";

export interface Port {
  id: string;
  label: string;
  kind: SignalKind;
}

import type { MergeRule } from "./aggregate.js";
import { sizeLayerStep } from "./grid.js";

export interface GraphNode {
  id: string;
  title: string;
  category: NodeCategory;
  /** world coords of top-left corner */
  x: number;
  y: number;
  /**
   * depth in position space (default 0): under viewport 3-D rotation the
   * node's PROJECTED position shifts with z, but the node itself always
   * renders as an upright 2-D card facing the user
   */
  z?: number;
  w: number;
  /**
   * data-flow direction through this node (default "ltr"): decides which
   * edge carries the inputs and which the outputs. It is also what lets two
   * nodes SNAP-CONNECT — pushed flush together, an output edge meeting a
   * compatible input edge wires itself up (see snapConnections).
   */
  flow?: Flow;
  inputs: Port[];
  outputs: Port[];
  /** label: value rows shown in the node body */
  fields: [string, string][];
  /**
   * how each field MERGES when this node renormalizes into a block —
   * declared with the data it governs, e.g. { "min score": "max",
   * device: "set", vad: "any" }. Takes precedence over host-level
   * fieldSummarize maps; unlisted keys fall back to "mode".
   */
  fieldRules?: Record<string, MergeRule>;
  /**
   * pinned: excluded from dragging (and future auto-layout) — an immovable
   * anchor other nodes snap around. Toggled via the header pin glyph.
   */
  pinned?: boolean;
  /**
   * CONTAINMENT: id of the node this one lives inside. A node referenced
   * as someone's parent becomes a CONTAINER — it renders as an open frame
   * around its children and, once every child falls below readability, it
   * absorbs them into one block titled by the container (org-chart teams,
   * subgraphs). Containment is a structural relation like an edge, not a
   * style tag, and it is the sanctioned exception to one-cell-one-thing:
   * a child occupies its container's cell at a finer grid layer.
   */
  parent?: string;
  /**
   * explicit height override (world units) — resize grows the live-body
   * region; ignored when below the derived minimum (rows + bodyRows)
   */
  h?: number;
  /**
   * CONTENT SCALE (default 1): how large this node renders ITSELF —
   * every internal metric (header, rows, padding, ports, fonts, and the
   * body/draw hooks' pixels) multiplies by it. Distinct from w/h, which
   * only say how much world the node occupies: growing w gives the same
   * 11px rows more room, raising scale magnifies the node like a lens.
   * Shift+drag on the corner grip rescales (aspect-preserving); a plain
   * drag resizes.
   *
   * SETTING THIS ALONE DOES NOT RESIZE THE BOX. w/h are not derived from
   * scale, so a node left at its base w/h with scale=2 keeps its old width
   * while its type doubles: nodeMinHeight doubles, nodeHeight() silently
   * snaps the height up past the declared h (how far depends on the row
   * count — the box always drifts off the ratio the author declared), and
   * the body/draw hooks receive half the content width they had. Nothing
   * throws. To magnify a node, move all
   * three together, height read BEFORE scale is assigned:
   *
   *     n.w *= s; n.h = nodeHeight(n) * s; n.scale = s;
   *
   * or let Rgui.rescaleNode(id, s) do it for you.
   */
  scale?: number;
  /** custom block background fill (default #2b3036) */
  bg?: string;
  /**
   * annotation / sticky-card node: renders as a plain card frame (no header
   * band, ports, or field rows) whose rich content is the HTML `overlay` (or a
   * `draw` callback). It still lives in world space and drags/snaps/selects
   * like any node, and may be connectable if given outputs. Use annotationNode()
   * to build one. Beats overloading a data node with custom draw + an overlay.
   */
  note?: boolean;
  /**
   * node-anchored HTML overlay (interactive form controls etc.) — rgui
   * glues the element to the node's screen rect every frame and hides it
   * (without destroying) when the node collapses, goes off-screen, or is
   * too small to read. Size is screen-fixed.
   */
  overlay?: {
    el: HTMLElement;
    anchor?: "right" | "below" | "over";
    offset?: { x: number; y: number };
    interactive?: boolean;
    /** "fixed" (screen-constant, default) | "zoom" (scales with view.k) |
     * "fit" (scales to fill the node's screen area). See NodeHtmlOverlay. */
    scale?: "fixed" | "zoom" | "fit";
    /** zoom/fit: hide once the applied scale drops below this (default 0.75) */
    minScale?: number;
    /** fit: cap on the applied scale (default 1 — never upscale past natural) */
    maxScale?: number;
    /** clip the overlay to the node rect / viewport / not at all */
    clip?: "node" | "viewport" | "none";
    overflow?: "hidden" | "auto";
    destroy?: () => void;
  };
  /**
   * Full-content draw override: when set, rgui still owns the node block
   * (shape, fused boundaries, border, ports, pin, selection) but the ENTIRE
   * content — title, fields, everything — is drawn by this hook instead of
   * the defaults. Same contract as `body`: SCREEN-space ctx clipped to the
   * node, origin at the node's top-left, rect in screen px.
   */
  draw?: (
    ctx: CanvasRenderingContext2D,
    rect: { width: number; height: number },
    view: { k: number },
  ) => void;
  /**
   * Reserved live-body rows below the field rows (row height NODE_ROW_H).
   * The `body` hook draws inside this region.
   */
  bodyRows?: number;
  /**
   * Live-body draw hook: called every rendered frame with a SCREEN-space
   * ctx clipped to the body region (origin at the region's top-left,
   * rect in screen px). Auto-skipped when the node is collapsed into a
   * pseudo-node or too small to read. Call viewer.invalidate() when the
   * live data changes to schedule a redraw.
   */
  body?: (
    ctx: CanvasRenderingContext2D,
    rect: { width: number; height: number },
    view: { k: number },
  ) => void;
}

export interface Edge {
  from: { node: string; port: string };
  to: { node: string; port: string };
  /** dashed = event/stream-style wire */
  dashed?: boolean;
  /** per-edge style overrides (defaults come from the signal kind) */
  style?: {
    color?: string;
    /** screen px */
    width?: number;
    /** canvas dash pattern in screen px, e.g. [6, 5] */
    dash?: number[];
  };
  /** short label drawn at the wire midpoint */
  label?: string;
  /**
   * SNAP-CONNECTED: derived from geometry, not authored. Two nodes pushed
   * flush together with facing, kind-compatible ports wire themselves up;
   * drag them apart and the edge disappears. Temp edges are recomputed from
   * scratch on every move, so hosts must never persist them — filter them
   * out when saving, or promote one to a real edge to keep it.
   */
  temp?: boolean;
}

export interface Graph {
  nodes: GraphNode[];
  edges: Edge[];
}

// --- layout metrics (world units) -------------------------------------

export const NODE_HEADER_H = 26;
export const NODE_ROW_H = 22;
export const NODE_PAD = 10;
export const PORT_R = 5;
/** port pitch along a horizontal (top/bottom) edge — the ROW_H of vertical flow */
export const NODE_COL_W = 64;

/** content scale (default 1, always positive) */
export function contentScale(n: GraphNode): number {
  const s = n.scale ?? 1;
  return s > 0 ? s : 1;
}

/**
 * A node's interior metrics in WORLD units. The base constants describe a
 * scale-1 node; every interior length rides the node's content scale, which
 * is what makes a rescaled node a magnified copy of itself rather than a
 * bigger box holding the same small type.
 */
export function nodeMetrics(n: GraphNode): {
  s: number;
  headerH: number;
  rowH: number;
  pad: number;
  portR: number;
} {
  const s = contentScale(n);
  return {
    s,
    headerH: NODE_HEADER_H * s,
    rowH: NODE_ROW_H * s,
    pad: NODE_PAD * s,
    portR: PORT_R * s,
  };
}

/** number of stacked rows (fields vs. the taller port column) */
export function nodeRows(n: GraphNode): number {
  return Math.max(n.fields.length, Math.max(n.inputs.length, n.outputs.length));
}

/** derived minimum height (rows + reserved body rows) */
export function nodeMinHeight(n: GraphNode): number {
  const { headerH, rowH, pad } = nodeMetrics(n);
  return headerH + pad + (nodeRows(n) + (n.bodyRows ?? 0)) * rowH + pad;
}

/** derived minimum width — a scale-1 node never narrows below 96 wu */
export const NODE_MIN_W = 96;

export function nodeMinWidth(n: GraphNode): number {
  return NODE_MIN_W * contentScale(n);
}

export function nodeHeight(n: GraphNode): number {
  return Math.max(nodeMinHeight(n), n.h ?? 0);
}

/**
 * Build a first-class annotation / sticky-card node: a world-space card whose
 * body is rich HTML (the overlay `el`), with no ports/header/fields. It drags,
 * snaps, and selects like any node, and is connectable if given `outputs`.
 *   graph.nodes.push(annotationNode({ id, x, y, w: 240, el: myCard,
 *     title: "What is this?" }))
 *
 * `scale` controls how the HTML body tracks zoom: "fixed" (screen-constant,
 * default — keeps buttons/text readable) or "fit"/"zoom" to scale with the
 * card's world frame (with minScale/maxScale). Passing BOTH `el` and `draw`
 * works well: the HTML body shows up close, and the canvas `draw` acts as a
 * lower-detail fallback once the overlay hides (below minScale / too small).
 */
export function annotationNode(opts: {
  id: string;
  x: number;
  y: number;
  w?: number;
  h?: number;
  /** rich HTML body glued over the card (interactive) */
  el?: HTMLElement;
  /** or a canvas-draw body (screen px within the card rect); also a good LOD
   * fallback drawn when the `el` overlay hides at small scales */
  draw?: (ctx: CanvasRenderingContext2D, rect: { width: number; height: number }) => void;
  title?: string;
  /** card fill (default node background) */
  bg?: string;
  /** make the card connectable by giving it output ports */
  outputs?: Port[];
  /** overlay scale mode (default "fixed" — screen-constant) */
  scale?: "fixed" | "zoom" | "fit";
  /** zoom/fit: hide below this applied scale (default 0.75) */
  minScale?: number;
  /** fit: cap on the applied scale (default 1) */
  maxScale?: number;
  /** clip the HTML body to the card / viewport / not at all */
  clip?: "node" | "viewport" | "none";
  overflow?: "hidden" | "auto";
}): GraphNode {
  return {
    id: opts.id,
    title: opts.title ?? "",
    category: "note",
    x: opts.x,
    y: opts.y,
    w: opts.w ?? 220,
    h: opts.h ?? 120,
    inputs: [],
    outputs: opts.outputs ?? [],
    fields: [],
    bg: opts.bg,
    note: true,
    draw: opts.draw,
    overlay: opts.el
      ? {
          el: opts.el,
          anchor: "over",
          interactive: true,
          scale: opts.scale,
          minScale: opts.minScale,
          maxScale: opts.maxScale,
          clip: opts.clip,
          overflow: opts.overflow,
        }
      : undefined,
  };
}

/**
 * A node's scale, per axis: the grid layer each dimension lives on
 * (sizeLayerStep of w and of height). Width and height may legitimately
 * live on DIFFERENT layers — a wide-flat node is coarse in x, fine in y —
 * and position snapping follows each axis's own layer.
 */
export function nodeScale(
  n: GraphNode,
  radix = 8,
): { x: number; y: number } {
  return {
    x: sizeLayerStep(n.w, radix),
    y: sizeLayerStep(nodeHeight(n), radix),
  };
}

// --- containment ------------------------------------------------------

/** direct children of a container node */
export function childrenOf(graph: Graph, id: string): GraphNode[] {
  return graph.nodes.filter((n) => n.parent === id);
}

/** every node transitively inside a container */
export function descendantsOf(graph: Graph, id: string): GraphNode[] {
  const out: GraphNode[] = [];
  const q = [id];
  while (q.length) {
    const cur = q.pop()!;
    for (const n of graph.nodes)
      if (n.parent === cur) {
        out.push(n);
        q.push(n.id);
      }
  }
  return out;
}

/** ids of every node that contains others (has at least one child) */
export function containerIds(graph: Graph): Set<string> {
  const out = new Set<string>();
  for (const n of graph.nodes) if (n.parent) out.add(n.parent);
  return out;
}

/**
 * Containment predicate factory. `related(a, b)` is true when one node
 * contains the other (any depth). Containment overlap is SANCTIONED — a
 * child occupies its container's cell at a finer layer — so overlap
 * resolution, size clamping and flush-stack logic must skip related pairs.
 */
export function containmentOf(nodes: GraphNode[]): {
  inside: (a: string, b: string) => boolean;
  related: (a: string, b: string) => boolean;
} {
  const parent = new Map<string, string | undefined>(
    nodes.map((n) => [n.id, n.parent]),
  );
  const inside = (a: string, b: string): boolean => {
    for (let c = parent.get(a); c; c = parent.get(c)) if (c === b) return true;
    return false;
  };
  return { inside, related: (a, b) => inside(a, b) || inside(b, a) };
}

/** world-space rect of the reserved live-body region (null if none) */
export function bodyRect(
  n: GraphNode,
): { x: number; y: number; w: number; h: number } | null {
  if (!n.bodyRows) return null;
  const { headerH, rowH, pad } = nodeMetrics(n);
  const top = n.y + headerH + pad + nodeRows(n) * rowH;
  // any resized extra height flows into the live-body region
  return {
    x: n.x + pad,
    y: top,
    w: n.w - 2 * pad,
    h: n.y + nodeHeight(n) - pad - top,
  };
}

// --- flow direction ---------------------------------------------------

/** the axis data runs along: "h" for ltr/rtl, "v" for ttb/btt */
export function flowAxis(n: GraphNode): "h" | "v" {
  const f = n.flow ?? "ltr";
  return f === "ltr" || f === "rtl" ? "h" : "v";
}

/** the edge this node's inputs sit on */
export function inSide(n: GraphNode): Side {
  switch (n.flow ?? "ltr") {
    case "rtl":
      return "right";
    case "ttb":
      return "top";
    case "btt":
      return "bottom";
    default:
      return "left";
  }
}

/** the edge this node's outputs sit on (always opposite the inputs) */
export function outSide(n: GraphNode): Side {
  return oppositeSide(inSide(n));
}

export function oppositeSide(s: Side): Side {
  return s === "left"
    ? "right"
    : s === "right"
      ? "left"
      : s === "top"
        ? "bottom"
        : "top";
}

/** true when `s` runs along the x axis, i.e. it is the top or bottom edge */
export const isHorizontalSide = (s: Side): boolean =>
  s === "top" || s === "bottom";

/** world y of a node's i-th port/field row center */
export function nodeRowY(n: GraphNode, i: number): number {
  const { headerH, rowH, pad } = nodeMetrics(n);
  return n.y + headerH + pad + (i + 0.5) * rowH;
}

/**
 * World center of the i-th port on a given SIDE of the node. Ports on the
 * left/right edges stack down in rowH rows (clearing the title band); ports on
 * the top/bottom edges march across in NODE_COL_W columns. Both pitches ride the
 * node's content scale, and both are constant for a given scale — so two nodes
 * with the same corner alignment and scale present their port i at the same
 * coordinate, which is what makes snap-connect land on whole ports instead of
 * guessing.
 */
export function sidePortPos(
  n: GraphNode,
  side: Side,
  i: number,
): [number, number] {
  if (isHorizontalSide(side)) {
    const { s, pad } = nodeMetrics(n);
    return [
      n.x + pad + (i + 0.5) * NODE_COL_W * s,
      side === "top" ? n.y : n.y + nodeHeight(n),
    ];
  }
  return [side === "left" ? n.x : n.x + n.w, nodeRowY(n, i)];
}

/** world position of the i-th port on the node's declared in/out edge */
export function portPos(
  n: GraphNode,
  dir: "in" | "out",
  i: number,
): [number, number] {
  return sidePortPos(n, dir === "in" ? inSide(n) : outSide(n), i);
}

/** world position of an input port center */
export function inputPortPos(n: GraphNode, i: number): [number, number] {
  return portPos(n, "in", i);
}

/** world position of an output port center */
export function outputPortPos(n: GraphNode, i: number): [number, number] {
  return portPos(n, "out", i);
}

// --- demo graph: our take on the otoji jolly-finch-ibni pipeline ------
// positions AND sizes sit ON the radix-8 lattice (main step 64 wu at k=1):
// each node spans an integer 1..8 grids per axis — corners land on dots

export function demoGraph(): Graph {
  const nodes: GraphNode[] = [
    {
      id: "cam",
      title: "Camera",
      category: "source",
      x: -512,
      y: -192,
      w: 256,
      h: 128,
      inputs: [],
      outputs: [{ id: "image", label: "image", kind: "image" }],
      fields: [
        ["peer", "rusty-fox (me)"],
        ["device", "Default camera"],
      ],
    },
    {
      id: "mic",
      title: "Mic + VAD",
      category: "source",
      x: -512,
      y: 64,
      w: 256,
      h: 128,
      inputs: [],
      outputs: [{ id: "audio", label: "audio", kind: "audio" }],
      fields: [
        ["peer", "rusty-fox (me)"],
        ["vad", "on"],
      ],
      fieldRules: { vad: "any", peer: "set" },
    },
    {
      id: "vision",
      title: "Vision model",
      category: "model",
      x: -192,
      y: -256,
      w: 256,
      h: 192,
      inputs: [{ id: "image", label: "image", kind: "image" }],
      outputs: [
        { id: "image", label: "image", kind: "image" },
        { id: "labels", label: "labels.txt", kind: "text" },
        { id: "json", label: "json.txt", kind: "text" },
        { id: "rate", label: "rate-ctl", kind: "ctl" },
      ],
      fields: [
        ["task", "Object detection"],
        ["model", "YOLOS-tiny (fast)"],
        ["min score", "0.5"],
      ],
      // merge behavior declared with the data it governs
      fieldRules: { "min score": "max", model: "set" },
    },
    {
      id: "stt",
      title: "SenseVoice STT",
      category: "model",
      x: -192,
      y: 128,
      w: 256,
      h: 192,
      inputs: [{ id: "audio", label: "audio", kind: "audio" }],
      outputs: [{ id: "transcript", label: "transcript", kind: "text" }],
      fields: [["lang", "auto"]],
    },
    {
      id: "translate",
      title: "Translate",
      category: "model",
      x: 128,
      y: 128,
      w: 256,
      h: 128,
      inputs: [{ id: "text", label: "text", kind: "text" }],
      outputs: [{ id: "text", label: "text", kind: "text" }],
      fields: [["to", "en"]],
      fieldRules: { to: "set" },
    },
    {
      id: "voice",
      title: "Voice sink",
      category: "sink",
      x: 512,
      y: -64,
      w: 256,
      h: 192,
      inputs: [
        { id: "transcript", label: "transcript", kind: "text" },
        { id: "labels", label: "labels", kind: "text" },
        { id: "rate", label: "rate-ctl", kind: "ctl" },
      ],
      outputs: [],
      fields: [
        ["voice", "Auto (match lang)"],
        ["rate", "1×"],
      ],
    },
  ];

  const edges: Edge[] = [
    { from: { node: "cam", port: "image" }, to: { node: "vision", port: "image" } },
    { from: { node: "mic", port: "audio" }, to: { node: "stt", port: "audio" } },
    {
      from: { node: "stt", port: "transcript" },
      to: { node: "translate", port: "text" },
      dashed: true,
    },
    {
      from: { node: "translate", port: "text" },
      to: { node: "voice", port: "transcript" },
      dashed: true,
    },
    {
      from: { node: "vision", port: "labels" },
      to: { node: "voice", port: "labels" },
      dashed: true,
    },
    {
      from: { node: "vision", port: "rate" },
      to: { node: "voice", port: "rate" },
      dashed: true,
    },
  ];

  return { nodes, edges };
}

// --- demo: org chart — containment drives the RG levels ----------------
// teams are CONTAINER nodes; zooming out, each team absorbs its people
// into one team block (headcount sums, roles collect into a set), then the
// company absorbs the teams — leader/members/team/company ARE the RG levels.
// Custom kinds ("report") and categories ("org"/"team"/"lead"/"member")
// show the open type system: unknown names get stable derived colors.

export function orgChartGraph(): Graph {
  const person = (
    id: string,
    title: string,
    parent: string,
    x: number,
    y: number,
    role: string,
    lead = false,
  ): GraphNode => ({
    id,
    title,
    category: lead ? "lead" : "member",
    parent,
    x,
    y,
    w: 256,
    h: 128,
    // everyone reports to someone except the top of the tree
    inputs:
      lead && parent === "company"
        ? []
        : [{ id: "lead", label: "lead", kind: "report" }],
    outputs: lead ? [{ id: "reports", label: "reports", kind: "report" }] : [],
    fields: [
      ["role", role],
      ["headcount", "1"],
    ],
    fieldRules: { headcount: "sum", role: "set" },
  });

  const nodes: GraphNode[] = [
    {
      id: "company",
      title: "Acme Inc.",
      category: "org",
      x: -128,
      y: -128,
      w: 2048,
      h: 1536,
      inputs: [],
      outputs: [],
      fields: [["dept", "Product"]],
    },
    {
      id: "team-eng",
      title: "Engineering",
      category: "team",
      parent: "company",
      x: 0,
      y: 0,
      w: 1024,
      h: 512,
      inputs: [],
      outputs: [],
      fields: [],
    },
    {
      id: "team-design",
      title: "Design",
      category: "team",
      parent: "company",
      x: 0,
      y: 640,
      w: 1024,
      h: 512,
      inputs: [],
      outputs: [],
      fields: [],
    },
    // clear of the teams so the CEO's own collapsed block (screen-constant
    // minimum size) never collides with a team block while zooming out
    person("ceo", "Mori (CEO)", "company", 1536, 128, "CEO", true),
    person("lead-eng", "Aoi (EM)", "team-eng", 64, 64, "EM", true),
    person("eng-a", "Riku", "team-eng", 576, 64, "backend"),
    person("eng-b", "Hana", "team-eng", 576, 256, "frontend"),
    person("lead-des", "Sora (DM)", "team-design", 64, 704, "DM", true),
    person("des-a", "Yui", "team-design", 576, 704, "visual"),
  ];

  const report = (from: string, to: string): Edge => ({
    from: { node: from, port: "reports" },
    to: { node: to, port: "lead" },
  });
  const edges: Edge[] = [
    report("ceo", "lead-eng"),
    report("ceo", "lead-des"),
    report("lead-eng", "eng-a"),
    report("lead-eng", "eng-b"),
    report("lead-des", "des-a"),
  ];

  return { nodes, edges };
}
