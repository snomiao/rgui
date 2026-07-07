/**
 * Canvas 2D node-graph layer, Bitwig The Grid-style:
 * dark rounded modules, colored category header strip, side ports,
 * signal-colored bezier wires (dashed for event streams).
 *
 * Semantic zoom: draws the LOD RenderGraph — collapsed groups appear as
 * pseudo-nodes at constant screen size; node inner detail fades out
 * before it becomes unreadable.
 */
import {
  inputPortPos,
  nodeHeight,
  outputPortPos,
  NODE_HEADER_H,
  NODE_PAD,
  NODE_ROW_H,
  PORT_R,
  type Graph,
  type GraphNode,
  type SignalKind,
} from "../core/graph";
import {
  buildRenderGraph,
  endpointPos,
  pseudoRect,
  type PseudoNode,
  type RenderGraph,
} from "../core/lod";
import { DEFAULT_RULE, type RgRule } from "../core/rule";
import type { ViewTransform } from "../core/grid";

export const KIND_COLOR: Record<SignalKind, string> = {
  image: "#2dd4bf", // teal
  audio: "#fb923c", // orange
  text: "#60a5fa", // blue
  ctl: "#facc15", // yellow
};

const CATEGORY_COLOR: Record<GraphNode["category"], string> = {
  source: "#e07a3f", // bitwig orange
  model: "#4f8fd0", // bitwig blue
  sink: "#5cb87a", // green
};

const PSEUDO_HEADER = "#8a72c9"; // purple = group

export function drawGraph(
  ctx: CanvasRenderingContext2D,
  t: ViewTransform,
  graph: Graph,
  rule: RgRule = DEFAULT_RULE,
): RenderGraph {
  const rg = buildRenderGraph(graph, t.k, rule);

  ctx.save();
  // draw in world space; regular strokes/text zoom with the world
  ctx.translate(t.x, t.y);
  ctx.scale(t.k, t.k);

  for (const n of rg.nodes) drawNode(ctx, n, t.k, rule);
  for (const p of rg.pseudo) drawPseudoNode(ctx, p, t.k, rule);

  // wires draw ON TOP of nodes: connections carry the meaning of the graph
  // and cost far fewer pixels than nodes — never hide them
  for (const e of rg.edges) {
    const [x0, y0] = endpointPos(e.from, t.k, rule);
    const [x1, y1] = endpointPos(e.to, t.k, rule);
    ctx.strokeStyle = KIND_COLOR[e.kind];
    ctx.lineWidth = Math.min(2, 2 / t.k); // keep wires <= ~2px on screen
    ctx.setLineDash(e.dashed ? [6 / t.k, 5 / t.k] : []);
    const dx = Math.max(40, Math.abs(x1 - x0) * 0.5);
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.bezierCurveTo(x0 + dx, y0, x1 - dx, y1, x1, y1);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  ctx.restore();
  return rg;
}

function drawNode(
  ctx: CanvasRenderingContext2D,
  n: GraphNode,
  k: number,
  rule: RgRule,
) {
  const h = nodeHeight(n);
  const r = 8;

  // body
  ctx.beginPath();
  ctx.roundRect(n.x, n.y, n.w, h, r);
  ctx.fillStyle = "#2b3036";
  ctx.fill();
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = "#14161a";
  ctx.stroke();

  // header strip
  ctx.beginPath();
  ctx.roundRect(n.x, n.y, n.w, NODE_HEADER_H, [r, r, 0, 0]);
  ctx.fillStyle = CATEGORY_COLOR[n.category];
  ctx.fill();

  // title
  ctx.fillStyle = "#101215";
  ctx.font = "bold 13px system-ui, sans-serif";
  ctx.textBaseline = "middle";
  ctx.textAlign = "left";
  ctx.fillText(n.title, n.x + NODE_PAD, n.y + NODE_HEADER_H / 2 + 0.5);

  // field rows — skip when they would render unreadably small
  if (NODE_ROW_H * k >= rule.fieldMinPx) {
    ctx.font = "11px system-ui, sans-serif";
    for (let i = 0; i < n.fields.length; i++) {
      const [key, v] = n.fields[i]!;
      const y = n.y + NODE_HEADER_H + NODE_PAD + (i + 0.5) * NODE_ROW_H;
      ctx.fillStyle = "#8b949e";
      ctx.textAlign = "left";
      ctx.fillText(key, n.x + NODE_PAD + 10, y);
      ctx.fillStyle = "#e6e9ec";
      ctx.textAlign = "right";
      ctx.fillText(v, n.x + n.w - NODE_PAD - 10, y);
    }
  }

  // ports
  const labels = NODE_ROW_H * k >= rule.portLabelMinPx;
  ctx.font = "10px system-ui, sans-serif";
  for (let i = 0; i < n.inputs.length; i++) {
    const p = n.inputs[i]!;
    const [x, y] = inputPortPos(n, i);
    drawPort(ctx, x, y, KIND_COLOR[p.kind], PORT_R);
  }
  for (let i = 0; i < n.outputs.length; i++) {
    const p = n.outputs[i]!;
    const [x, y] = outputPortPos(n, i);
    drawPort(ctx, x, y, KIND_COLOR[p.kind], PORT_R);
    if (labels) {
      // outputs get labels outside the node (bitwig-ish signal tags)
      ctx.fillStyle = KIND_COLOR[p.kind];
      ctx.textAlign = "left";
      ctx.fillText(p.label, x + PORT_R + 4, y);
    }
  }
}

/**
 * Pseudo-node: constant SCREEN-size module. We draw it inside an
 * unscaled context so text stays crisp and readable at any zoom.
 */
function drawPseudoNode(
  ctx: CanvasRenderingContext2D,
  p: PseudoNode,
  k: number,
  rule: RgRule,
) {
  const PSEUDO = rule.pseudo;
  const rect = pseudoRect(p, k, rule);

  ctx.save();
  // undo world scale: position by world coords, size/text in screen px
  ctx.translate(rect.x, rect.y);
  ctx.scale(1 / k, 1 / k);
  const w = rect.w * k;
  const h = rect.h * k;
  const r = 8;

  const accent = p.category ? CATEGORY_COLOR[p.category] : PSEUDO_HEADER;

  // stacked-cards shadow hints "this is a group" (groups only)
  if (!p.category) {
    ctx.beginPath();
    ctx.roundRect(6, 6, w, h, r);
    ctx.fillStyle = "rgba(20, 22, 26, 0.6)";
    ctx.fill();
  }

  ctx.beginPath();
  ctx.roundRect(0, 0, w, h, r);
  ctx.fillStyle = "#2b3036";
  ctx.fill();
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = accent;
  ctx.stroke();

  ctx.beginPath();
  ctx.roundRect(0, 0, w, PSEUDO.headerH, [r, r, 0, 0]);
  ctx.fillStyle = accent;
  ctx.fill();

  ctx.fillStyle = "#101215";
  ctx.font = "bold 13px system-ui, sans-serif";
  ctx.textBaseline = "middle";
  ctx.textAlign = "left";
  ctx.fillText(p.title, PSEUDO.pad, PSEUDO.headerH / 2 + 0.5);

  ctx.font = "10px system-ui, sans-serif";
  for (let i = 0; i < p.inputs.length; i++) {
    const port = p.inputs[i]!;
    const y = PSEUDO.headerH + PSEUDO.pad + (i + 0.5) * PSEUDO.rowH;
    drawPort(ctx, 0, y, KIND_COLOR[port.kind], PORT_R);
    ctx.fillStyle = KIND_COLOR[port.kind];
    ctx.textAlign = "left";
    ctx.fillText(port.label, PORT_R + 4, y);
  }
  for (let i = 0; i < p.outputs.length; i++) {
    const port = p.outputs[i]!;
    const y = PSEUDO.headerH + PSEUDO.pad + (i + 0.5) * PSEUDO.rowH;
    drawPort(ctx, w, y, KIND_COLOR[port.kind], PORT_R);
    ctx.fillStyle = KIND_COLOR[port.kind];
    ctx.textAlign = "right";
    ctx.fillText(port.label, w - PORT_R - 4, y);
  }
  ctx.restore();
}

function drawPort(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  color: string,
  r: number,
) {
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = "#14161a";
  ctx.stroke();
}
