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
  bodyRect,
  contentScale,
  inputPortPos,
  nodeHeight,
  nodeMetrics,
  nodeRowY,
  outputPortPos,
  NODE_HEADER_H,
  PORT_R,
  type Graph,
  type GraphNode,
  type Side,
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
import { defaultSummarize } from "../core/aggregate.js";
import type { SummarizeFn, SummaryContent } from "../core/summary.js";
import {
  computePortLayout,
  flushPairKeys,
  flushSegments,
  sideCoverage,
  subtractIntervals,
  type FlushSegment,
  type PortPlacement,
  type SideCoverage,
} from "../core/pack.js";
import type { ViewTransform } from "../core/grid.js";
import { DARK_THEME, withAlpha, type RgTheme } from "../core/theme.js";

export const KIND_COLOR: Record<string, string> = {
  image: "#2dd4bf", // teal
  audio: "#fb923c", // orange
  text: "#60a5fa", // blue
  ctl: "#facc15", // yellow
};

export const CATEGORY_COLOR: Record<string, string> = {
  source: "#e07a3f", // bitwig orange
  model: "#4f8fd0", // bitwig blue
  sink: "#5cb87a", // green
};

/** stable derived color for names outside the built-in palettes — any
 * domain's kinds/categories render without registration (assign into
 * KIND_COLOR / CATEGORY_COLOR to pick exact colors) */
function hashColor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++)
    h = (h * 31 + name.charCodeAt(i)) % 360;
  // hsl(h, 45%, 55%) emitted as hex so theme utils (withAlpha) can parse it
  const s = 0.45;
  const l = 0.55;
  const f = (o: number) => {
    const t = (o + h / 30) % 12;
    const a = s * Math.min(l, 1 - l);
    const v = l - a * Math.max(-1, Math.min(t - 3, 9 - t, 1));
    return Math.round(v * 255)
      .toString(16)
      .padStart(2, "0");
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}

export function kindColor(kind: SignalKind): string {
  return KIND_COLOR[kind] ?? hashColor(kind);
}

export function categoryColor(category: GraphNode["category"]): string {
  return CATEGORY_COLOR[category] ?? hashColor(category);
}

/**
 * Active theme for this draw pass. Rendering is synchronous, so the exported
 * entry points set it from their theme argument and every helper below reads
 * it — no per-helper plumbing, and concurrent viewers can't interleave.
 */
let T: RgTheme = DARK_THEME;

export function drawGraph(
  ctx: CanvasRenderingContext2D,
  t: ViewTransform,
  graph: Graph,
  rule: RgRule = DEFAULT_RULE,
  summarize?: SummarizeFn,
  xform?: readonly [number, number, number, number],
  theme: RgTheme = DARK_THEME,
  /** zoom-out hysteresis: memberships carried from the previous finer scale */
  carry?: readonly [string, string][],
): RenderGraph {
  T = theme;
  const rg = buildRenderGraph(graph, t.k, rule, xform, carry);

  ctx.save();
  // draw in world space; regular strokes/text zoom with the world
  ctx.translate(t.x, t.y);
  ctx.scale(t.k, t.k);

  // boundary dissolution: flush-contact boundaries dissolve. Borders are drawn only on
  // UNCOVERED segments; corners at a junction lose their radius; ports whose
  // wires all stay inside one flush component vanish (the stack itself
  // renders the connection); external ports sit on the edge their wire
  // actually leaves from.
  const segments = flushSegments(rg.nodes);
  const touching = flushPairKeys(segments);
  const cover = sideCoverage(segments);
  const layout = computePortLayout(graph, rg.nodes, segments);

  // containers render as OPEN FRAMES behind their children — outermost
  // first, so nested frames and the cards inside stay on top
  const isContainer = new Set<string>();
  const parentOf = new Map<string, string>();
  for (const n of graph.nodes)
    if (n.parent) {
      isContainer.add(n.parent);
      parentOf.set(n.id, n.parent);
    }
  const depth = (id: string) => {
    let d = 0;
    for (let c = parentOf.get(id); c; c = parentOf.get(c)) d++;
    return d;
  };
  const frames = rg.nodes
    .filter((n) => isContainer.has(n.id))
    .sort((a, b) => depth(a.id) - depth(b.id));
  for (const n of frames) drawContainerFrame(ctx, n, t.k, rule, layout);
  for (const n of rg.nodes) {
    if (isContainer.has(n.id)) continue;
    drawNode(ctx, n, t.k, rule, cover.get(n.id), layout, summarize);
  }
  for (const p of rg.pseudo) drawPseudoNode(ctx, p, t.k, rule, summarize);

  // wires draw ON TOP of nodes: connections carry the meaning of the graph
  // and cost far fewer pixels than nodes — never hide them.
  // Exception (辺界消融): a wire between DIRECTLY touching nodes dissolves
  // into the seam — marked by a solder joint so "snapped + connected" stays
  // distinguishable from merely "snapped".
  for (const e of rg.edges) {
    if (
      e.from.at === "node" &&
      e.to.at === "node" &&
      touching.has([e.from.node.id, e.to.node.id].sort().join("|"))
    ) {
      drawSolderJoint(ctx, e.from.node, e.to.node, e, segments, t.k);
      continue;
    }
    const from = endpointPlaced(e.from, layout, t.k, rule);
    const to = endpointPlaced(e.to, layout, t.k, rule);
    const style = e.source.style;
    const color = style?.color ?? kindColor(e.kind);
    const width = style?.width ?? 2;
    ctx.strokeStyle = color;
    ctx.lineWidth = Math.min(width, width / t.k); // cap at `width` screen px
    const dash = style?.dash ?? (e.dashed ? [6, 5] : []);
    ctx.setLineDash(dash.map((d) => d / t.k));
    // control points bow OUT of each port along its edge normal
    const bow = Math.max(40, Math.hypot(to.x - from.x, to.y - from.y) * 0.4);
    const c0x = from.x + from.nx * bow;
    const c0y = from.y + from.ny * bow;
    const c1x = to.x + to.nx * bow;
    const c1y = to.y + to.ny * bow;
    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    ctx.bezierCurveTo(c0x, c0y, c1x, c1y, to.x, to.y);
    ctx.stroke();
    ctx.setLineDash([]);
    if (e.source.label) {
      // label at the bezier midpoint (t=0.5), kept readable on screen
      const mx = 0.125 * (from.x + to.x) + 0.375 * (c0x + c1x);
      const my = 0.125 * (from.y + to.y) + 0.375 * (c0y + c1y);
      ctx.save();
      ctx.translate(mx, my);
      ctx.scale(1 / t.k, 1 / t.k);
      ctx.font = "10px system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      const tw = ctx.measureText(e.source.label).width;
      ctx.fillStyle = T.labelBg;
      ctx.fillRect(-tw / 2 - 4, -8, tw + 8, 16);
      ctx.fillStyle = color;
      ctx.fillText(e.source.label, 0, 0);
      ctx.restore();
    }
  }

  ctx.restore();
  return rg;
}

/**
 * Seam flow chevron: a wire between snapped nodes condenses into a
 * kind-colored arrowhead ON the dissolved boundary, pointing from the
 * source node into the target — the same flow language as the port
 * handles, so a fused stack still reads its data direction.
 */
function drawSolderJoint(
  ctx: CanvasRenderingContext2D,
  a: GraphNode,
  b: GraphNode,
  e: RenderEdgeLike,
  segments: FlushSegment[],
  k: number,
) {
  const seg = segments.find(
    (s) =>
      (s.a === a && s.b === b) || (s.a === b && s.b === a),
  );
  if (!seg) return;
  // place the chevron near the connected ports' rows, clamped into the seam
  const oi = a.outputs.findIndex((p) => p.id === e.source.from.port);
  const ii = b.inputs.findIndex((p) => p.id === e.source.to.port);
  const py =
    ((oi >= 0 ? outputPortPos(a, oi)[1] : seg.from) +
      (ii >= 0 ? inputPortPos(b, ii)[1] : seg.to)) /
    2;
  const px =
    ((oi >= 0 ? outputPortPos(a, oi)[0] : seg.from) +
      (ii >= 0 ? inputPortPos(b, ii)[0] : seg.to)) /
    2;
  const margin = 9;
  // flow direction: from the output node's center toward the input node's
  const angle =
    seg.axis === "v"
      ? a.x + a.w / 2 <= b.x + b.w / 2
        ? 0 // rightward through the vertical seam
        : Math.PI
      : a.y + nodeHeight(a) / 2 <= b.y + nodeHeight(b) / 2
        ? Math.PI / 2 // downward through the horizontal seam
        : -Math.PI / 2;
  const cx =
    seg.axis === "v"
      ? seg.at
      : Math.min(seg.to - margin, Math.max(seg.from + margin, px));
  const cy =
    seg.axis === "v"
      ? Math.min(seg.to - margin, Math.max(seg.from + margin, py))
      : seg.at;

  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(angle);
  const r = 6.5; // slightly larger than port chevrons — it stands alone
  ctx.beginPath();
  ctx.moveTo(-3, -r);
  ctx.lineTo(r - 0.5, 0);
  ctx.lineTo(-3, r);
  ctx.lineTo(-0.5, 0);
  ctx.closePath();
  ctx.fillStyle = kindColor(e.kind);
  ctx.globalAlpha = 0.95;
  ctx.fill();
  ctx.lineWidth = Math.min(1.5, 1.5 / k);
  ctx.strokeStyle = T.ink;
  ctx.stroke();
  ctx.restore();
}

interface RenderEdgeLike {
  kind: keyof typeof KIND_COLOR;
  source: { from: { port: string }; to: { port: string } };
}

/** world position of a node's header pin glyph (toggle target) */
export function pinPos(n: GraphNode): [number, number] {
  const s = contentScale(n);
  return [n.x + n.w - 14 * s, n.y + (NODE_HEADER_H * s) / 2];
}

/**
 * Wire endpoint position + the outward normal of the edge it leaves from.
 * The normal (not a bare ±1) is what lets a wire bow correctly out of a
 * top/bottom port on a vertical-flow node.
 */
function endpointPlaced(
  ref: Parameters<typeof endpointPos>[0],
  layout: Map<string, PortPlacement>,
  k: number,
  rule: RgRule,
): { x: number; y: number; nx: number; ny: number } {
  if (ref.at === "node") {
    const dir = ref.side === "in" ? "in" : "out";
    const list = dir === "in" ? ref.node.inputs : ref.node.outputs;
    const port = list[ref.index];
    const pl = port && layout.get(`${ref.node.id}/${dir}/${port.id}`);
    if (pl) {
      const [nx, ny] = edgeNormal(pl.edge);
      return { x: pl.x, y: pl.y, nx, ny };
    }
  }
  const [x, y] = endpointPos(ref, k, rule);
  return { x, y, nx: ref.side === "out" ? 1 : -1, ny: 0 };
}

/**
 * Enter a host hook's drawing space at world (x, y). The hook is promised
 * PIXELS, so we undo the world zoom — but keep the node's content scale, so
 * one hook pixel becomes `s` screen pixels and a 2x node's hand-drawn body
 * magnifies exactly like its type does. At s=1 this is the old `scale(1/k)`.
 */
function hookSpace(
  ctx: CanvasRenderingContext2D,
  n: GraphNode,
  x: number,
  y: number,
  k: number,
) {
  ctx.translate(x, y);
  const s = contentScale(n);
  ctx.scale(s / k, s / k);
  // neutral text state for the host hook (leaked textAlign footgun)
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
}

/** the world rect (w, h) measured in a hook's own pixels */
function hookRect(w: number, h: number, k: number, s: number) {
  return { width: (w * k) / s, height: (h * k) / s };
}

function drawNode(
  ctx: CanvasRenderingContext2D,
  n: GraphNode,
  k: number,
  rule: RgRule,
  cover: SideCoverage | undefined,
  layout: Map<string, PortPlacement>,
  summarize?: SummarizeFn,
) {
  const h = nodeHeight(n);
  const m = nodeMetrics(n);
  const r = 8 * m.s;
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
  ctx.fillStyle = n.bg ?? T.nodeBg;
  ctx.fill();

  drawNodeBorder(ctx, n, h, [tl, tr, br, bl], cov);

  // annotation / sticky-card node: a plain card frame — no header band, ports,
  // or field rows. Its rich content is the HTML overlay (glued on top by the
  // overlay manager) or an optional draw() body. Everything else (drag, snap,
  // selection, fused boundaries) still applies since it's a normal node.
  if (n.note) {
    if (n.draw) {
      ctx.save();
      ctx.beginPath();
      ctx.roundRect(n.x, n.y, n.w, h, [tl, tr, br, bl]);
      ctx.clip();
      ctx.translate(n.x, n.y);
      ctx.scale(1 / k, 1 / k);
      ctx.textAlign = "left";
      ctx.textBaseline = "alphabetic";
      try {
        n.draw(ctx, { width: n.w * k, height: h * k }, { k });
      } catch (err) {
        console.error("[rgui] annotation draw hook failed:", err);
      }
      ctx.restore();
    }
    return;
  }
  if (n.draw) {
    // full-content override: the node draws its own title/fields/body in
    // screen px; rgui keeps the block, ports, pin and fused boundaries
    ctx.save();
    ctx.beginPath();
    ctx.roundRect(n.x, n.y, n.w, h, [tl, tr, br, bl]);
    ctx.clip();
    hookSpace(ctx, n, n.x, n.y, k);
    try {
      n.draw(ctx, hookRect(n.w, h, k, m.s), { k: k * m.s });
    } catch (err) {
      console.error("[rgui] node draw hook failed:", err);
    }
    ctx.restore();
    // border re-strokes after the hook so a custom background can't cover it
    drawNodeBorder(ctx, n, h, [tl, tr, br, bl], cov);
    drawNodePin(ctx, n);
    drawNodePorts(ctx, n, k, rule, layout);
    drawResizeGrip(ctx, n, h);
    return;
  }

  // single block: no header band — the category speaks through the title
  // color, so a node (and a fused stack) reads as one uninterrupted shape
  ctx.fillStyle = categoryColor(n.category);
  ctx.font = `bold ${13 * m.s}px system-ui, sans-serif`;
  ctx.textBaseline = "middle";
  ctx.textAlign = "left";
  ctx.fillText(n.title, n.x + m.pad, n.y + m.headerH / 2 + 0.5 * m.s);

  drawNodePin(ctx, n);

  // readability rides the SCALED row height: a magnified node keeps its
  // detail further out, and a shrunken one drops it sooner
  const rowPx = m.rowH * k;

  // small-level summary: fields are below readability — ask the host for a
  // compact screen-constant summary instead of showing nothing
  if (rowPx < rule.fieldMinPx && summarize) {
    const sw = n.w * k;
    const sh = h * k;
    const content = summarize([n], {
      collapsed: false,
      level: "small",
      screen: { w: sw, h: sh },
    });
    if (content) {
      ctx.save();
      ctx.beginPath();
      ctx.roundRect(n.x, n.y, n.w, h, r);
      ctx.clip();
      ctx.translate(n.x, n.y);
      ctx.scale(1 / k, 1 / k); // screen px
      const top = Math.min(m.headerH * k, 16) + 2;
      drawSummaryContent(ctx, content, 6, top, sw - 12, sh - top - 4);
      ctx.restore();
    }
  }

  // field rows — skip when they would render unreadably small
  if (rowPx >= rule.fieldMinPx) {
    ctx.font = `${11 * m.s}px system-ui, sans-serif`;
    for (let i = 0; i < n.fields.length; i++) {
      const [key, v] = n.fields[i]!;
      const y = nodeRowY(n, i);
      ctx.fillStyle = T.textMuted;
      ctx.textAlign = "left";
      ctx.fillText(key, n.x + m.pad + 10 * m.s, y);
      ctx.fillStyle = T.text;
      ctx.textAlign = "right";
      ctx.fillText(v, n.x + n.w - m.pad - 10 * m.s, y);
    }
  }

  // live body — host-drawn region (waveform / partial text / thumbnails).
  // Hook-pixel ctx clipped to the region; skipped when unreadably small.
  const bodyR = bodyRect(n);
  if (n.body && bodyR && bodyR.h * k >= 12) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(bodyR.x, bodyR.y, bodyR.w, bodyR.h);
    ctx.clip();
    hookSpace(ctx, n, bodyR.x, bodyR.y, k);
    try {
      n.body(ctx, hookRect(bodyR.w, bodyR.h, k, m.s), { k: k * m.s });
    } catch (err) {
      console.error("[rgui] node body hook failed:", err);
    }
    ctx.restore();
  }

  drawNodePorts(ctx, n, k, rule, layout);
  drawResizeGrip(ctx, n, h);
}

/**
 * Container frame: an open region that HOLDS other nodes — accent border,
 * title and a near-transparent tint, so the children (finer grid citizens
 * living in this cell) read through it. Ports, pin and resize grip still
 * work: a container is a real node, not chrome.
 */
function drawContainerFrame(
  ctx: CanvasRenderingContext2D,
  n: GraphNode,
  k: number,
  rule: RgRule,
  layout: Map<string, PortPlacement>,
) {
  const h = nodeHeight(n);
  const m = nodeMetrics(n);
  const accent = categoryColor(n.category);
  ctx.beginPath();
  ctx.roundRect(n.x, n.y, n.w, h, 10 * m.s);
  ctx.fillStyle = withAlpha(accent, 0.05);
  ctx.fill();
  ctx.lineWidth = 1.5 * m.s;
  ctx.strokeStyle = withAlpha(accent, 0.6);
  ctx.stroke();

  ctx.fillStyle = accent;
  ctx.font = `bold ${13 * m.s}px system-ui, sans-serif`;
  ctx.textBaseline = "middle";
  ctx.textAlign = "left";
  ctx.fillText(n.title, n.x + m.pad, n.y + m.headerH / 2 + 0.5 * m.s);

  // containers may declare a few fields — same rows as a card, and the
  // author leaves that strip clear when placing children
  if (m.rowH * k >= rule.fieldMinPx) {
    ctx.font = `${11 * m.s}px system-ui, sans-serif`;
    for (let i = 0; i < n.fields.length; i++) {
      const [key, v] = n.fields[i]!;
      const y = nodeRowY(n, i);
      ctx.fillStyle = T.textMuted;
      ctx.textAlign = "left";
      ctx.fillText(key, n.x + m.pad + 10 * m.s, y);
      ctx.fillStyle = T.text;
      ctx.textAlign = "right";
      ctx.fillText(v, n.x + n.w - m.pad - 10 * m.s, y);
    }
  }

  drawNodePin(ctx, n);
  drawNodePorts(ctx, n, k, rule, layout);
  drawResizeGrip(ctx, n, h);
}

/** diagonal grip lines at the bottom-right corner (resize affordance) */
function drawResizeGrip(ctx: CanvasRenderingContext2D, n: GraphNode, h: number) {
  const s = contentScale(n);
  const x = n.x + n.w;
  const y = n.y + h;
  ctx.save();
  ctx.strokeStyle = T.textMuted;
  ctx.globalAlpha = 0.35;
  ctx.lineWidth = 1.2 * s;
  ctx.beginPath();
  ctx.moveTo(x - 9 * s, y - 3 * s);
  ctx.lineTo(x - 3 * s, y - 9 * s);
  ctx.moveTo(x - 5.5 * s, y - 3 * s);
  ctx.lineTo(x - 3 * s, y - 5.5 * s);
  ctx.stroke();
  ctx.restore();
}
function drawNodeBorder(
  ctx: CanvasRenderingContext2D,
  n: GraphNode,
  h: number,
  radii: [number, number, number, number],
  cov: SideCoverage,
) {
  const [tl, tr, br, bl] = radii;
  ctx.lineWidth = 1.5 * contentScale(n);
  ctx.strokeStyle = T.ink;
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
}

function drawNodePin(ctx: CanvasRenderingContext2D, n: GraphNode) {
  const [px, py] = pinPos(n);
  ctx.save();
  ctx.translate(px, py);
  ctx.scale(contentScale(n), contentScale(n));
  ctx.rotate(Math.PI / 4);
  ctx.globalAlpha = n.pinned ? 1 : 0.25;
  ctx.fillStyle = n.pinned ? T.accent : T.textMuted;
  ctx.strokeStyle = n.pinned ? T.accent : T.textMuted;
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  ctx.arc(0, -3, 3.2, 0, Math.PI * 2); // head
  ctx.fill();
  ctx.beginPath(); // needle
  ctx.moveTo(0, -0.5);
  ctx.lineTo(0, 5.5);
  ctx.stroke();
  ctx.restore();
}

function drawNodePorts(
  ctx: CanvasRenderingContext2D,
  n: GraphNode,
  k: number,
  rule: RgRule,
  layout: Map<string, PortPlacement>,
) {
  // ports — layout-driven: internal ports vanish (辺界消融), external ports
  // sit on the edge their wire leaves from
  const m = nodeMetrics(n);
  const labels = m.rowH * k >= rule.portLabelMinPx;
  ctx.font = `${10 * m.s}px system-ui, sans-serif`;
  ctx.textBaseline = "middle";
  const drawPorts = (dir: "in" | "out", ports: typeof n.inputs) => {
    for (const p of ports) {
      const pl = layout.get(`${n.id}/${dir}/${p.id}`);
      if (!pl || pl.hidden) continue;
      drawPort(
        ctx,
        pl.x,
        pl.y,
        kindColor(p.kind),
        m.portR,
        portDir(rule, dir, pl.edge),
        portAxis(pl.edge),
        m.s,
      );
      if (dir === "out" && labels) {
        ctx.fillStyle = kindColor(p.kind);
        // labels sit outside the node, clear of the port: beside a side edge,
        // above/below a cap edge
        if (pl.edge === "right") {
          ctx.textAlign = "left";
          ctx.fillText(p.label, pl.x + m.portR + 4 * m.s, pl.y);
        } else if (pl.edge === "left") {
          ctx.textAlign = "right";
          ctx.fillText(p.label, pl.x - m.portR - 4 * m.s, pl.y);
        } else {
          ctx.textAlign = "center";
          ctx.fillText(
            p.label,
            pl.x,
            pl.y +
              (pl.edge === "bottom" ? m.portR + 8 * m.s : -m.portR - 8 * m.s),
          );
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
  summarize?: SummarizeFn,
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

  const accent = p.category ? categoryColor(p.category) : T.pseudoHeader;

  // stacked-cards shadow hints "this is a group" (groups only)
  if (!p.category) {
    ctx.beginPath();
    ctx.roundRect(6, 6, w, h, r);
    ctx.fillStyle = T.shadow;
    ctx.fill();
  }

  ctx.beginPath();
  ctx.roundRect(0, 0, w, h, r);
  ctx.fillStyle = T.nodeBg;
  ctx.fill();
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = accent;
  ctx.stroke();

  // single block: accent lives in the border + title color, no header band
  ctx.fillStyle = accent;
  ctx.font = "bold 13px system-ui, sans-serif";
  ctx.textBaseline = "middle";
  ctx.textAlign = "left";
  ctx.fillText(p.title, PSEUDO.pad, PSEUDO.headerH / 2 + 0.5);

  ctx.font = "10px system-ui, sans-serif";
  for (let i = 0; i < p.inputs.length; i++) {
    const port = p.inputs[i]!;
    const y = PSEUDO.headerH + PSEUDO.pad + (i + 0.5) * PSEUDO.rowH;
    drawPort(ctx, 0, y, kindColor(port.kind), PORT_R, portDir(rule, "in", "left"));
    ctx.fillStyle = kindColor(port.kind);
    ctx.textAlign = "left";
    ctx.fillText(port.label, PORT_R + 4, y);
  }
  for (let i = 0; i < p.outputs.length; i++) {
    const port = p.outputs[i]!;
    const y = PSEUDO.headerH + PSEUDO.pad + (i + 0.5) * PSEUDO.rowH;
    drawPort(ctx, w, y, kindColor(port.kind), PORT_R, portDir(rule, "out", "right"));
    ctx.fillStyle = kindColor(port.kind);
    ctx.textAlign = "right";
    ctx.fillText(port.label, w - PORT_R - 4, y);
  }

  // group summary: drawn INSIDE the pseudo's interior, below the port rows
  // (the enclosure-sized box has the room; nothing extends outside).
  // No host summarize → default DATA MERGE (mode per field) applies.
  const content = (summarize ?? defaultSummarize)(p.members, {
    collapsed: true,
    level: "pseudo",
    screen: { w, h },
  });
  if (content) {
    const rows = Math.max(p.inputs.length, p.outputs.length, 1);
    const top = PSEUDO.headerH + PSEUDO.pad + rows * PSEUDO.rowH + PSEUDO.pad;
    const maxH = h - top - PSEUDO.pad;
    if (maxH >= 14) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(PSEUDO.pad, top, w - 2 * PSEUDO.pad, maxH);
      ctx.clip();
      drawSummaryContent(
        ctx,
        content,
        PSEUDO.pad,
        top,
        w - 2 * PSEUDO.pad,
        maxH,
      );
      ctx.restore();
    }
  }
  ctx.restore();
}

const SUMMARY_LINE_H = 14;

function summaryHeight(
  ctx: CanvasRenderingContext2D,
  c: SummaryContent,
): number {
  if (c.kind === "text") return Math.min(c.lines.length, 4) * SUMMARY_LINE_H;
  if (c.kind === "kv") return Math.min(c.rows.length, 4) * SUMMARY_LINE_H;
  return c.height ?? 36;
}

/** truncate a string to fit a pixel width (current ctx font) */
function fitText(ctx: CanvasRenderingContext2D, s: string, w: number): string {
  if (ctx.measureText(s).width <= w) return s;
  let lo = 0;
  let hi = s.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (ctx.measureText(s.slice(0, mid) + "…").width <= w) lo = mid;
    else hi = mid - 1;
  }
  return s.slice(0, lo) + "…";
}

/** draw summary content in SCREEN px at (x, y), clipped by the caller */
function drawSummaryContent(
  ctx: CanvasRenderingContext2D,
  c: SummaryContent,
  x: number,
  y: number,
  w: number,
  maxH: number,
) {
  if (c.kind === "canvas") {
    ctx.save();
    ctx.translate(x, y);
    ctx.textAlign = "left";
    ctx.textBaseline = "alphabetic";
    try {
      c.draw(ctx, { width: w, height: Math.min(c.height ?? 36, maxH) });
    } catch (err) {
      console.error("[rgui] summary draw failed:", err);
    }
    ctx.restore();
    return;
  }
  ctx.font = "10px system-ui, sans-serif";
  ctx.textBaseline = "middle";
  const rows = Math.min(
    Math.floor(maxH / SUMMARY_LINE_H),
    c.kind === "text" ? Math.min(c.lines.length, 4) : Math.min(c.rows.length, 4),
  );
  for (let i = 0; i < rows; i++) {
    const cy = y + (i + 0.5) * SUMMARY_LINE_H;
    if (c.kind === "text") {
      ctx.fillStyle = T.textDim;
      ctx.textAlign = "left";
      ctx.fillText(fitText(ctx, c.lines[i]!, w), x, cy);
    } else {
      const [key, v] = c.rows[i]!;
      ctx.fillStyle = T.textMuted;
      ctx.textAlign = "left";
      ctx.fillText(fitText(ctx, key, w * 0.4), x, cy);
      ctx.fillStyle = T.text;
      ctx.textAlign = "right";
      ctx.fillText(fitText(ctx, v, w * 0.55), x + w, cy);
    }
  }
}

/**
 * dir: +1 = flow points along the axis's positive direction, -1 = negative,
 * 0 = directionless dot. `axis` picks which axis: "h" draws ">"/"<", "v"
 * draws the same chevron rotated a quarter turn to point down/up.
 * Chevrons read the data flow: inputs point INTO the node, outputs point
 * OUT of it — LTR graphs show ">" on both edges.
 */
function drawPort(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  color: string,
  r: number,
  dir: -1 | 0 | 1 = 0,
  /** the port edge's axis — a "v" edge rotates the chevron 90° */
  axis: "h" | "v" = "h",
  /** node content scale — the chevron's notch and outline ride it */
  s = 1,
) {
  ctx.save();
  if (dir !== 0 && axis === "v") {
    // draw the horizontal chevron inside a frame turned 90°
    ctx.translate(x, y);
    ctx.rotate(Math.PI / 2);
    x = 0;
    y = 0;
  }
  ctx.beginPath();
  if (dir === 0) {
    ctx.arc(x, y, r, 0, Math.PI * 2);
  } else {
    // ">" chevron arrowhead with a back notch
    const d = dir;
    ctx.moveTo(x - 2.5 * s * d, y - r);
    ctx.lineTo(x + (r - 0.5 * s) * d, y);
    ctx.lineTo(x - 2.5 * s * d, y + r);
    ctx.lineTo(x - 0.5 * s * d, y);
    ctx.closePath();
  }
  ctx.fillStyle = color;
  ctx.fill();
  ctx.lineWidth = 1.5 * s;
  ctx.strokeStyle = T.ink;
  ctx.stroke();
  ctx.restore();
}

/** chevron direction for a port: inputs point into the node, outputs out */
function portDir(rule: RgRule, io: "in" | "out", edge: Side): -1 | 0 | 1 {
  if (rule.portShape === "dot") return 0;
  // out on a FAR edge (right/bottom) points forward along the axis, out on a
  // near edge points backward; inputs mirror that, so they point into the node
  const far = edge === "right" || edge === "bottom";
  return io === "out" ? (far ? 1 : -1) : far ? -1 : 1;
}

/** which axis a port's chevron runs along */
const portAxis = (edge: Side): "h" | "v" =>
  edge === "top" || edge === "bottom" ? "v" : "h";

/** outward unit normal of an edge — the direction a wire leaves the port */
export function edgeNormal(edge: Side): [number, number] {
  switch (edge) {
    case "left":
      return [-1, 0];
    case "right":
      return [1, 0];
    case "top":
      return [0, -1];
    default:
      return [0, 1];
  }
}

/** an off-screen marker: edge anchor + the world center it points at */
export interface OffscreenIndicator {
  /** anchor on the viewport edge (screen px) */
  ax: number;
  ay: number;
  angle: number;
  color: string;
  /** world center of the off-screen target */
  cx: number;
  cy: number;
}

/**
 * Game-style off-screen indicators: for every node fully outside the
 * viewport, an arrow pinned to the viewport edge points at it — zoomed in
 * close, you stay aware of what lies outside. Clicking one navigates there.
 */
export function offscreenIndicators(
  t: ViewTransform,
  rg: RenderGraph,
  size: { width: number; height: number },
  rule: RgRule = DEFAULT_RULE,
  mapPoint?: (x: number, y: number) => readonly [number, number],
): OffscreenIndicator[] {
  const { width: W, height: H } = size;
  const m = 18; // edge inset for the markers
  const clamp = (v: number, lo: number, hi: number) =>
    Math.min(hi, Math.max(lo, v));

  const out: OffscreenIndicator[] = [];
  const add = (
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    color: string,
  ) => {
    // under viewport rotation, test the mapped center against the viewport
    // grown by the rect's half-diagonal (a solid approximation)
    let sx = (x0 + x1) / 2;
    let sy = (y0 + y1) / 2;
    let off = x1 < 0 || x0 > W || y1 < 0 || y0 > H;
    if (mapPoint) {
      [sx, sy] = mapPoint(sx, sy);
      const hd = Math.hypot(x1 - x0, y1 - y0) / 2;
      off = sx + hd < 0 || sx - hd > W || sy + hd < 0 || sy - hd > H;
    }
    if (off) {
      const ax = clamp(sx, m, W - m);
      const ay = clamp(sy, m, H - m);
      const wx = (((x0 + x1) / 2) - t.x) / t.k;
      const wy = (((y0 + y1) / 2) - t.y) / t.k;
      out.push({
        ax,
        ay,
        angle: Math.atan2(sy - ay, sx - ax),
        color,
        cx: wx,
        cy: wy,
      });
    }
  };
  for (const n of rg.nodes)
    add(
      n.x * t.k + t.x,
      n.y * t.k + t.y,
      (n.x + n.w) * t.k + t.x,
      (n.y + nodeHeight(n)) * t.k + t.y,
      categoryColor(n.category),
    );
  for (const p of rg.pseudo) {
    const r = pseudoRect(p, t.k, rule);
    add(
      r.x * t.k + t.x,
      r.y * t.k + t.y,
      (r.x + r.w) * t.k + t.x,
      (r.y + r.h) * t.k + t.y,
      p.category ? categoryColor(p.category) : T.pseudoHeader,
    );
  }
  return out;
}

export function drawOffscreenIndicators(
  ctx: CanvasRenderingContext2D,
  t: ViewTransform,
  rg: RenderGraph,
  size: { width: number; height: number },
  rule: RgRule = DEFAULT_RULE,
  mapPoint?: (x: number, y: number) => readonly [number, number],
  theme?: RgTheme,
): OffscreenIndicator[] {
  if (theme) T = theme;
  const items = offscreenIndicators(t, rg, size, rule, mapPoint);
  for (const it of items) {
    ctx.save();
    ctx.translate(it.ax, it.ay);
    ctx.rotate(it.angle);
    // chevron pointing toward the off-screen node
    ctx.beginPath();
    ctx.moveTo(9, 0);
    ctx.lineTo(-5, 5.5);
    ctx.lineTo(-2, 0);
    ctx.lineTo(-5, -5.5);
    ctx.closePath();
    ctx.globalAlpha = 0.95;
    ctx.fillStyle = it.color;
    ctx.fill();
    ctx.lineWidth = 1;
    ctx.strokeStyle = T.ink;
    ctx.stroke();
    ctx.restore();
  }
  return items;
}
