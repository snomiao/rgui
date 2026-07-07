/**
 * rgui core — node-graph model (framework-agnostic, world coordinates).
 * Bitwig The Grid-style: compact modules with a colored category header,
 * input ports on the left edge, output ports on the right edge.
 */

export type SignalKind = "image" | "audio" | "text" | "ctl";

export type NodeCategory = "source" | "model" | "sink";

export interface Port {
  id: string;
  label: string;
  kind: SignalKind;
}

export interface GraphNode {
  id: string;
  title: string;
  category: NodeCategory;
  /** world coords of top-left corner */
  x: number;
  y: number;
  w: number;
  inputs: Port[];
  outputs: Port[];
  /** label: value rows shown in the node body */
  fields: [string, string][];
  /**
   * pinned: excluded from dragging (and future auto-layout) — an immovable
   * anchor other nodes snap around. Toggled via the header pin glyph.
   */
  pinned?: boolean;
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

export function nodeHeight(n: GraphNode): number {
  const rows = Math.max(
    n.fields.length,
    Math.max(n.inputs.length, n.outputs.length),
  );
  return (
    NODE_HEADER_H +
    NODE_PAD +
    (rows + (n.bodyRows ?? 0)) * NODE_ROW_H +
    NODE_PAD
  );
}

/** world-space rect of the reserved live-body region (null if none) */
export function bodyRect(
  n: GraphNode,
): { x: number; y: number; w: number; h: number } | null {
  if (!n.bodyRows) return null;
  const rows = Math.max(
    n.fields.length,
    Math.max(n.inputs.length, n.outputs.length),
  );
  return {
    x: n.x + NODE_PAD,
    y: n.y + NODE_HEADER_H + NODE_PAD + rows * NODE_ROW_H,
    w: n.w - 2 * NODE_PAD,
    h: n.bodyRows * NODE_ROW_H,
  };
}

/** world position of an input port center */
export function inputPortPos(n: GraphNode, i: number): [number, number] {
  return [n.x, n.y + NODE_HEADER_H + NODE_PAD + (i + 0.5) * NODE_ROW_H];
}

/** world position of an output port center */
export function outputPortPos(n: GraphNode, i: number): [number, number] {
  return [n.x + n.w, n.y + NODE_HEADER_H + NODE_PAD + (i + 0.5) * NODE_ROW_H];
}

// --- demo graph: our take on the otoji jolly-finch-ibni pipeline ------

export function demoGraph(): Graph {
  const nodes: GraphNode[] = [
    {
      id: "cam",
      title: "Camera",
      category: "source",
      x: -560,
      y: -180,
      w: 200,
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
      x: -560,
      y: 60,
      w: 200,
      inputs: [],
      outputs: [{ id: "audio", label: "audio", kind: "audio" }],
      fields: [
        ["peer", "rusty-fox (me)"],
        ["vad", "on"],
      ],
    },
    {
      id: "vision",
      title: "Vision model",
      category: "model",
      x: -240,
      y: -220,
      w: 240,
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
    },
    {
      id: "stt",
      title: "SenseVoice STT",
      category: "model",
      x: -240,
      y: 80,
      w: 240,
      inputs: [{ id: "audio", label: "audio", kind: "audio" }],
      outputs: [{ id: "transcript", label: "transcript", kind: "text" }],
      fields: [["lang", "auto"]],
    },
    {
      id: "voice",
      title: "Voice sink",
      category: "sink",
      x: 140,
      y: -80,
      w: 220,
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
