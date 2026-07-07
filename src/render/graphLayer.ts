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
} from "../core/graph.js";
import {
  buildRenderGraph,
  endpointPos,
  pseudoRect,
  type PseudoNode,
  type RenderGraph,
} from "../core/lod.js";
import { DEFAULT_RULE, type RgRule } from "../core/rule.js";
import {
  computePortLayout,
  flushComponents,
  flushSegments,
  sideCoverage,
  subtractIntervals,
  type PortPlacement,
  type SideCoverage,
} from "../core/pack.js";
import type { ViewTransform } from "../core/grid.js";

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

  // 辺界消融: flush-contact boundaries dissolve. Borders are drawn only on
  // UNCOVERED segments; corners at a junction lose their radius; ports whose
  // wires all stay inside one flush component vanish (the stack itself
  // renders the connection); external ports sit on the edge their wire
  // actually leaves from.
  const segments = flushSegments(rg.nodes);
  const comp = flushComponents(rg.nodes, segments);
  const cover = sideCoverage(segments);
  const layout = computePortLayout(graph, rg.nodes, segments);

  for (const n of rg.nodes)
    drawNode(ctx, n, t.k, rule, cover.get(n.id), layout);
  for (const p of rg.pseudo) drawPseudoNode(ctx, p, t.k, rule);

  // wires draw ON TOP of nodes: connections carry the meaning of the graph
  // and cost far fewer pixels than nodes — never hide them.
  // Exception (辺界消融): wires inside one flush component dissolve —
  // physical stacking renders the connection.
  for (const e of rg.edges) {
    if (
      e.from.at === "node" &&
      e.to.at === "node" &&
      comp.get(e.from.node.id) === comp.get(e.to.node.id)
    )
      continue;
    const from = endpointPlaced(e.from, layout, t.k, rule);
    const to = endpointPlaced(e.to, layout, t.k, rule);
    ctx.strokeStyle = KIND_COLOR[e.kind];
    ctx.lineWidth = Math.min(2, 2 / t.k); // keep wires <= ~2px on screen
    ctx.setLineDash(e.dashed ? [6 / t.k, 5 / t.k] : []);
    const dx = Math.max(40, Math.abs(to.x - from.x) * 0.5);
    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    ctx.bezierCurveTo(
      from.x + from.dir * dx,
      from.y,
      to.x + to.dir * dx,
      to.y,
      to.x,
      to.y,
    );
    ctx.stroke();
    ctx.setLineDash([]);
  }

  ctx.restore();
  return rg;
}

/** wire endpoint position + outgoing direction, honoring port layout */
function endpointPlaced(
  ref: Parameters<typeof endpointPos>[0],
  layout: Map<string, PortPlacement>,
  k: number,
  rule: RgRule,
): { x: number; y: number; dir: 1 | -1 } {
  if (ref.at === "node") {
    const dir = ref.side === "in" ? "in" : "out";
    const list = dir === "in" ? ref.node.inputs : ref.node.outputs;
    const port = list[ref.index];
    const pl = port && layout.get(`${ref.node.id}/${dir}/${port.id}`);
    if (pl) return { x: pl.x, y: pl.y, dir: pl.edge === "right" ? 1 : -1 };
  }
  const [x, y] = endpointPos(ref, k, rule);
  return { x, y, dir: ref.side === "out" ? 1 : -1 };
}

function drawNode(
  ctx: CanvasRenderingContext2D,
  n: GraphNode,
  k: number,
  rule: RgRule,
  cover: SideCoverage | undefined,
  layout: Map<string, PortPlacement>,
) {
  const h = nodeHeight(n);
  const r = 8;
  const cov: SideCoverage = cover ?? {
    top: [],
    right: [],
    bottom: [],
    left: [],
  };

  // a corner squares off when a flush junction reaches it
  const near = (ivs: { from: number; to: number }[], v: number) =>
    ivs.some((iv) => iv.from <= v + r && iv.to >= v - r);
  const tl = near(cov.top, n.x) || near(cov.left, n.y) ? 0 : r;
  const tr = near(cov.top, n.x + n.w) || near(cov.right, n.y) ? 0 : r;
  const br = near(cov.bottom, n.x + n.w) || near(cov.right, n.y + h) ? 0 : r;
  const bl = near(cov.bottom, n.x) || near(cov.left, n.y + h) ? 0 : r;

  // body fill (fills butt together squarely at junctions)
  ctx.beginPath();
  ctx.roundRect(n.x, n.y, n.w, h, [tl, tr, br, bl]);
  ctx.fillStyle = "#2b3036";
  ctx.fill();

  // border: stroke only the uncovered pieces of each side + live corners
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = "#14161a";
  ctx.beginPath();
  for (const seg of subtractIntervals(
    { from: n.x + tl, to: n.x + n.w - tr },
    cov.top,
  )) {
    ctx.moveTo(seg.from, n.y);
    ctx.lineTo(seg.to, n.y);
  }
  for (const seg of subtractIntervals(
    { from: n.y + tr, to: n.y + h - br },
    cov.right,
  )) {
    ctx.moveTo(n.x + n.w, seg.from);
    ctx.lineTo(n.x + n.w, seg.to);
  }
  for (const seg of subtractIntervals(
    { from: n.x + bl, to: n.x + n.w - br },
    cov.bottom,
  )) {
    ctx.moveTo(seg.from, n.y + h);
    ctx.lineTo(seg.to, n.y + h);
  }
  for (const seg of subtractIntervals(
    { from: n.y + tl, to: n.y + h - bl },
    cov.left,
  )) {
    ctx.moveTo(n.x, seg.from);
    ctx.lineTo(n.x, seg.to);
  }
  if (tl) ctx.moveTo(n.x, n.y + tl), ctx.arc(n.x + tl, n.y + tl, tl, Math.PI, 1.5 * Math.PI);
  if (tr) ctx.moveTo(n.x + n.w - tr, n.y), ctx.arc(n.x + n.w - tr, n.y + tr, tr, 1.5 * Math.PI, 2 * Math.PI);
  if (br) ctx.moveTo(n.x + n.w, n.y + h - br), ctx.arc(n.x + n.w - br, n.y + h - br, br, 0, 0.5 * Math.PI);
  if (bl) ctx.moveTo(n.x + bl, n.y + h), ctx.arc(n.x + bl, n.y + h - bl, bl, 0.5 * Math.PI, Math.PI);
  ctx.stroke();

  // header strip
  ctx.beginPath();
  ctx.roundRect(n.x, n.y, n.w, NODE_HEADER_H, [tl, tr, 0, 0]);
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

  // ports — layout-driven: internal ports vanish (辺界消融), external ports
  // sit on the edge their wire leaves from
  const labels = NODE_ROW_H * k >= rule.portLabelMinPx;
  ctx.font = "10px system-ui, sans-serif";
  const drawPorts = (dir: "in" | "out", ports: typeof n.inputs) => {
    for (const p of ports) {
      const pl = layout.get(`${n.id}/${dir}/${p.id}`);
      if (!pl || pl.hidden) continue;
      drawPort(ctx, pl.x, pl.y, KIND_COLOR[p.kind], PORT_R);
      if (dir === "out" && labels) {
        ctx.fillStyle = KIND_COLOR[p.kind];
        if (pl.edge === "right") {
          ctx.textAlign = "left";
          ctx.fillText(p.label, pl.x + PORT_R + 4, pl.y);
        } else {
          ctx.textAlign = "right";
          ctx.fillText(p.label, pl.x - PORT_R - 4, pl.y);
        }
      }
    }
  };
  drawPorts("in", n.inputs);
  drawPorts("out", n.outputs);
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
