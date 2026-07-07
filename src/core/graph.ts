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
   * explicit height override (world units) — resize grows the live-body
   * region; ignored when below the derived minimum (rows + bodyRows)
   */
  h?: number;
  /** custom block background fill (default #2b3036) */
  bg?: string;
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

/** derived minimum height (rows + reserved body rows) */
export function nodeMinHeight(n: GraphNode): number {
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

export function nodeHeight(n: GraphNode): number {
  return Math.max(nodeMinHeight(n), n.h ?? 0);
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

/** world-space rect of the reserved live-body region (null if none) */
export function bodyRect(
  n: GraphNode,
): { x: number; y: number; w: number; h: number } | null {
  if (!n.bodyRows) return null;
  const rows = Math.max(
    n.fields.length,
    Math.max(n.inputs.length, n.outputs.length),
  );
  const top = n.y + NODE_HEADER_H + NODE_PAD + rows * NODE_ROW_H;
  // any resized extra height flows into the live-body region
  return {
    x: n.x + NODE_PAD,
    y: top,
    w: n.w - 2 * NODE_PAD,
    h: n.y + nodeHeight(n) - NODE_PAD - top,
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
