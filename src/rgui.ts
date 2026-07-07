/**
 * rgui — high-level viewer: readable-grid canvas with pan/zoom (d3-zoom),
 * grid-snapped node dragging, semantic-zoom LOD graph rendering, and an
 * optional debug panel. Framework-agnostic: mount on any <canvas>.
 */
import { select } from "d3-selection";
import { zoom, zoomIdentity, type D3ZoomEvent } from "d3-zoom";
import {
  createCanvas2DRenderer,
  createGridDotsLayer,
  type DrawLayer,
} from "./render/canvas2d.js";
import {
  drawGraph,
  drawOffscreenIndicators,
  pinPos,
  KIND_COLOR,
  type OffscreenIndicator,
} from "./render/graphLayer.js";
import {
  drawPanelDragGhost,
  drawPanels,
  panelHitAt,
  panelLayout,
  type Panel,
  type PanelItem,
  type PanelRect,
} from "./render/panelLayer.js";
import {
  createOverlayManager,
  type NodeHtmlOverlay,
} from "./render/overlayLayer.js";
import {
  createWebGPUGridRenderer,
  type WebGPUGridRenderer,
} from "./render/webgpu.js";
import {
  inputPortPos,
  nodeHeight,
  nodeMinHeight,
  outputPortPos,
  type Edge,
  type Graph,
  type GraphNode,
  type Port,
} from "./core/graph.js";
import { pseudoRect, type PseudoNode, type RenderGraph } from "./core/lod.js";
import {
  clampSize,
  computePortLayout,
  flushPairKeys,
  flushSegments,
  resolveOverlap,
} from "./core/pack.js";
import { layoutGraph, type LayoutOptions } from "./core/layout.js";
import { resolveRule, type RgRule } from "./core/rule.js";
import type { SummarizeFn } from "./core/summary.js";
import {
  gridLevels,
  screenToWorld,
  snap,
  type ViewTransform,
} from "./core/grid.js";

export interface RguiOptions {
  /** the node graph to render (mutated in place by dragging) */
  graph?: Graph;
  /** customize every readability threshold for your use case */
  rule?: Partial<RgRule>;
  /** element to render live debug info into (grid px / scale / pos / size) */
  debug?: HTMLElement | null;
  /** extra draw layers rendered between the grid and the graph */
  layers?: DrawLayer[];
  /** initial view; default centers world origin in the viewport */
  view?: ViewTransform;
  /** called after each rendered frame */
  onFrame?: (view: ViewTransform, rg: RenderGraph | null) => void;

  // --- interaction callbacks (for host-app state sync, e.g. otoji rooms) ---

  /** fires on every grid-snapped position change during a drag (unthrottled) */
  onNodeMove?: (nodeId: string, pos: { x: number; y: number }) => void;
  /** fires once per node when a drag ends; pseudo drags fire per member */
  onNodeMoveEnd?: (nodeId: string, pos: { x: number; y: number }) => void;
  /** gate for interactive edge creation (port-to-port drag) */
  isValidConnection?: (from: PortRef, to: PortRef) => boolean;
  /** fires when a valid port-to-port drag completes; host owns graph mutation */
  onConnect?: (from: PortRef, to: PortRef) => void;
  /** plain click on a node (no drag movement) */
  onNodeClick?: (nodeId: string, screen: { x: number; y: number }) => void;
  /** right-click / context-menu on a node */
  onNodeContextMenu?: (
    nodeId: string,
    screen: { x: number; y: number },
  ) => void;
  /** selection changed (click select, shift+drag box select, setSelection) */
  onSelectionChange?: (nodeIds: string[]) => void;
  /** a node's pin was toggled via the header glyph */
  onPinChange?: (nodeId: string, pinned: boolean) => void;
  /** fires during a corner-grip resize (grid-snapped, overlap-clamped) */
  onNodeResize?: (nodeId: string, size: { w: number; h: number }) => void;
  /** fires once when a corner-grip resize ends */
  onNodeResizeEnd?: (nodeId: string, size: { w: number; h: number }) => void;
  /**
   * screen-anchored palettes/panels drawn as canvas chrome — items support
   * click-to-add (Panel.onItemClick) and drag-onto-canvas (Panel.onItemDrop)
   */
  panels?: Panel[];
  /**
   * summarize rule: when a node is too small for its fields ("small") or
   * nodes merge into a pseudo-node ("pseudo"), rgui asks for compact
   * host-defined content and renders it screen-constant. Return null to
   * fall back to defaults.
   */
  summarize?: SummarizeFn;
  /** right-click (no drag) on empty canvas */
  onCanvasContextMenu?: (
    screen: { x: number; y: number },
    world: { x: number; y: number },
  ) => void;
  /**
   * rendering backend (default "auto"): "webgpu" renders the background +
   * grid field on a GPU underlay canvas (graph content stays 2D on top);
   * falls back to "canvas2d" when WebGPU is unavailable
   */
  renderer?: "auto" | "canvas2d" | "webgpu";
  /**
   * input preset (default "figma"):
   * - figma: 2-finger scroll = pan · pinch / ctrl+wheel / mouse wheel = zoom ·
   *   plain or right drag on empty = box select · space+drag / middle drag = pan
   * - classic: wheel = zoom · plain drag on empty = pan · shift+drag = box select
   */
  input?: "figma" | "classic";
  /** plain click on a wire */
  onEdgeClick?: (edge: Edge, screen: { x: number; y: number }) => void;
  /** right-click / context-menu on a wire */
  onEdgeContextMenu?: (edge: Edge, screen: { x: number; y: number }) => void;
  /**
   * wire drag released on empty canvas (no valid target port) — open a
   * "create node here" palette and wire it up yourself
   */
  onConnectEnd?: (
    from: PortRef,
    at: { screen: { x: number; y: number }; world: { x: number; y: number } },
  ) => void;
}

/** reference to one port of one node */
export interface PortRef {
  node: string;
  port: string;
  side: "in" | "out";
}

export interface Rgui {
  canvas: HTMLCanvasElement;
  readonly view: ViewTransform;
  readonly rule: RgRule;
  /** active backend ("webgpu" once the GPU pipeline is live) */
  readonly rendererKind: "canvas2d" | "webgpu";
  graph: Graph;
  setGraph(g: Graph): void;
  /** selected node ids (click to select, shift+drag to box-select) */
  readonly selection: string[];
  setSelection(nodeIds: string[]): void;
  /** programmatic viewport control (syncs d3-zoom state) */
  setView(view: ViewTransform): void;
  /** fit all nodes into the viewport with the given screen-px padding */
  fitView(paddingPx?: number): void;
  /**
   * screen position of a port as currently laid out (flush-snap aware) —
   * null if the node/port is missing or collapsed into a pseudo-node.
   * `hidden` = dissolved into a flush stack (not drawn, not hittable).
   */
  portScreenPos(
    nodeId: string,
    portId: string,
    side: "in" | "out",
  ): { x: number; y: number; edge: "left" | "right"; hidden: boolean } | null;
  /** replace the panel set (host mutates panels + calls this or invalidate) */
  setPanels(panels: Panel[]): void;
  /**
   * attach/replace/remove a node-anchored HTML overlay at runtime
   * (declarative alternative: set GraphNode.overlay before rendering)
   */
  setNodeOverlay(
    nodeId: string,
    overlay: HTMLElement | NodeHtmlOverlay | null,
  ): void;
  /**
   * programmatic resize (for nodes that want to size themselves) — snapped
   * to minimums and clamped against neighbors (一格一物), then re-rendered
   */
  resizeNode(nodeId: string, size: { w?: number; h?: number }): void;
  /**
   * auto-layout by connection optimization (layered + barycenter). Pinned
   * nodes stay put. Animates ~300ms, then fires onNodeMoveEnd per moved node
   * so hosts can broadcast the new positions.
   */
  autoLayout(opts?: LayoutOptions & { animate?: boolean }): void;
  /**
   * screen midpoint of a wire's bezier as currently drawn — null if the
   * wire is dissolved (inside a flush stack) or an endpoint is collapsed.
   */
  edgeMidScreen(edge: {
    from: { node: string; port: string };
    to: { node: string; port: string };
  }): { x: number; y: number } | null;
  /** request a re-render on the next animation frame */
  invalidate(): void;
  destroy(): void;
}

type Hit =
  | { type: "node"; node: GraphNode }
  | { type: "pseudo"; pseudo: PseudoNode };

export function createRgui(
  canvas: HTMLCanvasElement,
  options: RguiOptions = {},
): Rgui {
  const rule = resolveRule(options.rule);
  let graph: Graph = options.graph ?? { nodes: [], edges: [] };
  let lastRg: RenderGraph | null = null;

  let lastIndicators: OffscreenIndicator[] = [];
  let panels: Panel[] = options.panels ?? [];
  let lastPanelRects: PanelRect[] = [];

  /** smooth-pan the viewport so the given world point lands center-screen */
  function panTo(cx: number, cy: number, durationMs = 280) {
    const W = canvas.clientWidth;
    const H = canvas.clientHeight;
    const k = view.k;
    const from = { x: view.x, y: view.y };
    const to = { x: W / 2 - cx * k, y: H / 2 - cy * k };
    const t0 = performance.now();
    const step = (now: number) => {
      const u = Math.min(1, (now - t0) / durationMs);
      const e = u < 0.5 ? 2 * u * u : 1 - (-2 * u + 2) ** 2 / 2; // easeInOut
      sel.call(
        zoomBehavior.transform,
        zoomIdentity
          .translate(from.x + (to.x - from.x) * e, from.y + (to.y - from.y) * e)
          .scale(k),
      );
      if (u < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  function indicatorAt(sx: number, sy: number): OffscreenIndicator | null {
    for (const it of lastIndicators)
      if (Math.hypot(it.ax - sx, it.ay - sy) <= 12) return it;
    return null;
  }

  let selection = new Set<string>();
  function applySelection(next: Set<string>) {
    const changed =
      next.size !== selection.size || [...next].some((id) => !selection.has(id));
    selection = next;
    if (changed) options.onSelectionChange?.([...next]);
    invalidate();
  }

  function drawSelectionLayer(
    ctx: CanvasRenderingContext2D,
    t: ViewTransform,
  ) {
    // highlight selected nodes (screen-constant stroke)
    if (selection.size) {
      ctx.save();
      ctx.strokeStyle = "#ffd60a";
      ctx.lineWidth = 2;
      for (const id of selection) {
        const n = graph.nodes.find((m) => m.id === id);
        if (!n) continue;
        const x = n.x * t.k + t.x;
        const y = n.y * t.k + t.y;
        ctx.beginPath();
        ctx.roundRect(
          x - 3,
          y - 3,
          n.w * t.k + 6,
          nodeHeight(n) * t.k + 6,
          10,
        );
        ctx.stroke();
      }
      ctx.restore();
    }
    // marquee
    if (drag?.type === "marquee") {
      ctx.save();
      ctx.strokeStyle = "#ffd60a";
      ctx.fillStyle = "rgba(255, 214, 10, 0.08)";
      ctx.lineWidth = 1;
      ctx.setLineDash([5, 4]);
      const x = Math.min(drag.x0, drag.x1);
      const y = Math.min(drag.y0, drag.y1);
      ctx.fillRect(x, y, Math.abs(drag.x1 - drag.x0), Math.abs(drag.y1 - drag.y0));
      ctx.strokeRect(x, y, Math.abs(drag.x1 - drag.x0), Math.abs(drag.y1 - drag.y0));
      ctx.restore();
    }
  }

  const fieldProvider = () =>
    lastIndicators.map((it) => ({ x: it.cx, y: it.cy }));
  const contentLayers: DrawLayer[] = [
    ...(options.layers ?? []),
    (ctx, t) =>
      (lastRg = drawGraph(ctx, t, graph, rule, options.summarize)),
    (ctx, t) => drawSelectionLayer(ctx, t),
    (ctx, t, size) => {
      lastIndicators = lastRg
        ? drawOffscreenIndicators(ctx, t, lastRg, size, rule)
        : [];
    },
    (ctx, t) => drawGhostWire(ctx, t),
    (ctx, _t, size) => {
      lastPanelRects = panelLayout(panels, size);
      drawPanels(ctx, lastPanelRects);
      if (drag?.type === "panelItem" && drag.moved)
        drawPanelDragGhost(ctx, view, drag.item, drag.sx, drag.sy);
    },
  ];
  const gridLayer = createGridDotsLayer(rule, fieldProvider);

  // backend selection: GPU underlay canvas for bg+grid, 2D content on top
  const wantGpu =
    (options.renderer ?? "auto") !== "canvas2d" &&
    typeof navigator !== "undefined" &&
    !!navigator.gpu;
  if ((options.renderer ?? "auto") === "webgpu" && !wantGpu)
    console.warn("[rgui] WebGPU requested but unavailable; using canvas2d");

  let rendererKind: "canvas2d" | "webgpu" = "canvas2d";
  let gpu: WebGPUGridRenderer | null = null;
  let underlay: HTMLCanvasElement | null = null;
  let renderer = createCanvas2DRenderer(
    canvas,
    wantGpu ? contentLayers : [gridLayer, ...contentLayers],
    { background: wantGpu ? false : undefined },
  );
  if (wantGpu) {
    underlay = document.createElement("canvas");
    underlay.className = "rgui-gpu-underlay";
    underlay.style.cssText =
      "position:absolute;inset:0;width:100%;height:100%;z-index:0;pointer-events:none;";
    const parent = canvas.parentElement;
    if (parent) {
      if (getComputedStyle(parent).position === "static")
        parent.style.position = "relative";
      if (getComputedStyle(canvas).position === "static")
        canvas.style.position = "relative";
      if (!canvas.style.zIndex) canvas.style.zIndex = "1";
      parent.insertBefore(underlay, canvas);
    }
    gpu = createWebGPUGridRenderer(underlay, rule, fieldProvider);
    gpu.ready.then((ok) => {
      if (destroyed) return;
      if (ok) {
        rendererKind = "webgpu";
      } else {
        // GPU init failed: tear down the underlay and go pure canvas2d
        underlay?.remove();
        underlay = null;
        gpu = null;
        renderer = createCanvas2DRenderer(
          canvas,
          [gridLayer, ...contentLayers],
        );
        renderer.resize();
      }
      invalidate();
    });
  }

  let view: ViewTransform = options.view ?? { x: 0, y: 0, k: 1 };

  const overlays = createOverlayManager(canvas);

  let raf = 0;
  let destroyed = false;
  function invalidate() {
    if (raf || destroyed) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      if (rendererKind === "webgpu") gpu?.render(view);
      renderer.render(view);
      overlays.sync(graph, lastRg?.nodes ?? null, view, rule);
      if (debugEl) updateDebug();
      options.onFrame?.(view, lastRg);
    });
  }

  // --- debug info panel -------------------------------------------------

  const debugEl = options.debug ?? null;
  let pointer = { sx: 0, sy: 0 };

  const fmt = (v: number, d = 2) =>
    Math.abs(v) >= 1e6 || (Math.abs(v) < 0.01 && v !== 0)
      ? v.toExponential(d)
      : +v.toFixed(d) + "";

  function updateDebug() {
    if (!debugEl) return;
    const [major, minor] = gridLevels(view.k, rule.minGridPx, rule.ladder);
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    const [cwx, cwy] = screenToWorld(view, w / 2, h / 2);
    const [pwx, pwy] = screenToWorld(view, pointer.sx, pointer.sy);
    const rem = parseFloat(
      getComputedStyle(document.documentElement).fontSize,
    );
    debugEl.innerHTML =
      `<span class="dim">scale </span><span class="hi">${fmt(view.k, 3)}×</span>` +
      `<span class="dim"> dpr </span>${devicePixelRatio}` +
      `<span class="dim"> · ${rendererKind}</span>\n` +
      `<span class="dim">grid  major </span><span class="hi">${fmt(major!.px, 1)}px</span>` +
      `<span class="dim"> (${fmt(major!.px / rem)}rem) = ${fmt(major!.step)} wu</span>\n` +
      `<span class="dim">      minor </span>${fmt(minor!.px, 1)}px` +
      `<span class="dim"> = ${fmt(minor!.step)} wu · α${fmt(minor!.alpha, 2)}</span>\n` +
      `<span class="dim">view  pos </span>${fmt(view.x, 1)}, ${fmt(view.y, 1)}px` +
      `<span class="dim"> center </span>${fmt(cwx)}, ${fmt(cwy)} wu\n` +
      `<span class="dim">size  </span>${w}×${h}px` +
      `<span class="dim"> = </span>${fmt(w / view.k)}×${fmt(h / view.k)} wu\n` +
      `<span class="dim">ptr   </span>${fmt(pwx)}, ${fmt(pwy)} wu`;
  }

  // --- hit-testing & dragging -------------------------------------------

  function hitAt(sx: number, sy: number): Hit | null {
    const [wx, wy] = screenToWorld(view, sx, sy);
    // pseudo-nodes draw on top of everything
    for (const p of lastRg?.pseudo ?? []) {
      const r = pseudoRect(p, view.k, rule);
      if (wx >= r.x && wx <= r.x + r.w && wy >= r.y && wy <= r.y + r.h)
        return { type: "pseudo", pseudo: p };
    }
    const visible = lastRg?.nodes ?? graph.nodes;
    for (let i = visible.length - 1; i >= 0; i--) {
      const n = visible[i]!;
      if (
        wx >= n.x &&
        wx <= n.x + n.w &&
        wy >= n.y &&
        wy <= n.y + nodeHeight(n)
      )
        return { type: "node", node: n };
    }
    return null;
  }

  /** screen-px hit radius for ports (zoom-invariant) */
  const PORT_HIT_PX = 10;

  interface PortHit {
    ref: PortRef;
    port: Port;
    wx: number;
    wy: number;
  }

  function portAt(sx: number, sy: number): PortHit | null {
    // only real (expanded) nodes expose wirable ports; positions follow the
    // same direction-aware layout the renderer uses (hidden ports skipped)
    const nodes = lastRg?.nodes ?? graph.nodes;
    const layout = computePortLayout(graph, nodes, flushSegments(nodes));
    for (const n of nodes) {
      const check = (dir: "in" | "out", ports: typeof n.inputs): PortHit | null => {
        for (const p of ports) {
          const pl = layout.get(`${n.id}/${dir}/${p.id}`);
          if (!pl || pl.hidden) continue;
          const [px, py] = worldToScreenXY(pl.x, pl.y);
          if (Math.hypot(px - sx, py - sy) <= PORT_HIT_PX)
            return {
              ref: { node: n.id, port: p.id, side: dir },
              port: p,
              wx: pl.x,
              wy: pl.y,
            };
        }
        return null;
      };
      const hit = check("in", n.inputs) ?? check("out", n.outputs);
      if (hit) return hit;
    }
    return null;
  }

  function worldToScreenXY(wx: number, wy: number): [number, number] {
    return [wx * view.k + view.x, wy * view.k + view.y];
  }

  /** hit-test wires: sample each rendered bezier, ~6px screen tolerance */
  function edgeAt(sx: number, sy: number): Edge | null {
    const nodes = lastRg?.nodes ?? graph.nodes;
    const layout = computePortLayout(graph, nodes, flushSegments(nodes));
    const byId = new Map(nodes.map((n) => [n.id, n]));
    for (const e of graph.edges) {
      const a = byId.get(e.from.node);
      const b = byId.get(e.to.node);
      if (!a || !b) continue; // endpoint collapsed or missing → wire not drawn
      const pf = layout.get(`${a.id}/out/${e.from.port}`);
      const pt = layout.get(`${b.id}/in/${e.to.port}`);
      if (!pf || !pt || pf.hidden || pt.hidden) continue;
      const [x0, y0] = worldToScreenXY(pf.x, pf.y);
      const [x1, y1] = worldToScreenXY(pt.x, pt.y);
      const dx = Math.max(40 * view.k, Math.abs(x1 - x0) * 0.5);
      const d0 = pf.edge === "right" ? 1 : -1;
      const d1 = pt.edge === "right" ? 1 : -1;
      const cx0 = x0 + d0 * dx;
      const cx1 = x1 + d1 * dx;
      for (let i = 0; i <= 24; i++) {
        const u = i / 24;
        const v = 1 - u;
        const bx = v * v * v * x0 + 3 * v * v * u * cx0 + 3 * v * u * u * cx1 + u * u * u * x1;
        const by = v * v * v * y0 + 3 * v * v * u * y0 + 3 * v * u * u * y1 + u * u * u * y1;
        if (Math.hypot(bx - sx, by - sy) <= 6) return e;
      }
    }
    return null;
  }

  let drag:
    | {
        type: "node";
        node: GraphNode;
        dx: number;
        dy: number;
        downX: number;
        downY: number;
        moved: boolean;
      }
    | { type: "pseudo"; pseudo: PseudoNode; wx: number; wy: number; moved: boolean }
    | { type: "wire"; from: PortHit; toSx: number; toSy: number }
    | {
        type: "marquee";
        x0: number;
        y0: number;
        x1: number;
        y1: number;
        button: number;
      }
    | { type: "resize"; node: GraphNode; moved: boolean }
    | {
        type: "panelItem";
        panel: Panel;
        item: PanelItem;
        sx: number;
        sy: number;
        downX: number;
        downY: number;
        moved: boolean;
      }
    | null = null;

  function drawGhostWire(ctx: CanvasRenderingContext2D, t: ViewTransform) {
    if (drag?.type !== "wire") return;
    const [x0, y0] = worldToScreenXY(drag.from.wx, drag.from.wy);
    const target = portAt(drag.toSx, drag.toSy);
    const ok = target ? validConnection(drag.from, target) : false;
    ctx.save();
    ctx.strokeStyle = target
      ? ok
        ? KIND_COLOR[drag.from.port.kind]
        : "#e5534b" // invalid target: red
      : KIND_COLOR[drag.from.port.kind];
    ctx.globalAlpha = 0.9;
    ctx.lineWidth = 2;
    ctx.setLineDash([7, 5]);
    const dx = Math.max(40 * t.k, Math.abs(drag.toSx - x0) * 0.5);
    const dir = drag.from.ref.side === "out" ? 1 : -1;
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.bezierCurveTo(
      x0 + dir * dx,
      y0,
      drag.toSx - dir * dx,
      drag.toSy,
      drag.toSx,
      drag.toSy,
    );
    ctx.stroke();
    ctx.restore();
  }

  /** structural check + host gate (default gate: matching signal kinds) */
  function validConnection(a: PortHit, b: PortHit): boolean {
    if (a.ref.side === b.ref.side || a.ref.node === b.ref.node) return false;
    const [from, to] = a.ref.side === "out" ? [a, b] : [b, a];
    if (options.isValidConnection)
      return options.isValidConnection(from.ref, to.ref);
    return from.port.kind === to.port.kind;
  }

  /** resize-grip hit-test: bottom-right corner, ~10px screen radius */
  function gripHitAt(sx: number, sy: number): GraphNode | null {
    for (const n of lastRg?.nodes ?? graph.nodes) {
      const [px, py] = worldToScreenXY(n.x + n.w, n.y + nodeHeight(n));
      if (Math.hypot(px - sx, py - sy) <= 10) return n;
    }
    return null;
  }

  /** pin-glyph hit-test (screen ~9px around the glyph) */
  function pinHitAt(sx: number, sy: number): GraphNode | null {
    for (const n of lastRg?.nodes ?? graph.nodes) {
      const [wx, wy] = pinPos(n);
      const [px, py] = worldToScreenXY(wx, wy);
      if (Math.hypot(px - sx, py - sy) <= 9) return n;
    }
    return null;
  }

  const onPointerDown = (ev: PointerEvent) => {
    if (spaceHeld && input === "figma") return; // space+drag = pan (d3 owns it)
    // panels are the topmost chrome
    const ph2 = panelHitAt(lastPanelRects, ev.offsetX, ev.offsetY);
    if (ph2) {
      if (ph2.type === "header") {
        ph2.rect.panel.collapsed = !ph2.rect.panel.collapsed;
        invalidate();
      } else if (ph2.type === "item") {
        drag = {
          type: "panelItem",
          panel: ph2.rect.panel,
          item: ph2.item,
          sx: ev.offsetX,
          sy: ev.offsetY,
          downX: ev.offsetX,
          downY: ev.offsetY,
          moved: false,
        };
        canvas.setPointerCapture(ev.pointerId);
      }
      return; // body clicks are consumed (panel blocks the canvas below)
    }
    // off-screen indicators are UI chrome on top: click = go to the node
    const ind = indicatorAt(ev.offsetX, ev.offsetY);
    if (ind) {
      panTo(ind.cx, ind.cy);
      return;
    }
    // bottom-right grip starts a resize
    const gripNode = gripHitAt(ev.offsetX, ev.offsetY);
    if (gripNode && !gripNode.pinned) {
      drag = { type: "resize", node: gripNode, moved: false };
      canvas.setPointerCapture(ev.pointerId);
      return;
    }
    // pin glyph toggles pinned state
    const pinNode = pinHitAt(ev.offsetX, ev.offsetY);
    if (pinNode) {
      pinNode.pinned = !pinNode.pinned;
      options.onPinChange?.(pinNode.id, !!pinNode.pinned);
      invalidate();
      return;
    }
    // ports win over node bodies (they overlap the node edge)
    const ph = portAt(ev.offsetX, ev.offsetY);
    if (ph && (options.onConnect || options.isValidConnection)) {
      drag = { type: "wire", from: ph, toSx: ev.offsetX, toSy: ev.offsetY };
      canvas.setPointerCapture(ev.pointerId);
      return;
    }
    const hit = hitAt(ev.offsetX, ev.offsetY);
    if (!hit) {
      // figma preset: plain / right drag on empty = box select (space or
      // middle button pans via d3); classic: shift+drag only
      const marquee =
        input === "figma"
          ? !spaceHeld && (ev.button === 0 || ev.button === 2)
          : ev.shiftKey;
      if (marquee) {
        drag = {
          type: "marquee",
          x0: ev.offsetX,
          y0: ev.offsetY,
          x1: ev.offsetX,
          y1: ev.offsetY,
          button: ev.button,
        };
        canvas.setPointerCapture(ev.pointerId);
      }
      return;
    }
    const [wx, wy] = screenToWorld(view, ev.offsetX, ev.offsetY);
    if (hit.type === "node") {
      const n = hit.node;
      drag = {
        type: "node",
        node: n,
        dx: wx - n.x,
        dy: wy - n.y,
        downX: ev.offsetX,
        downY: ev.offsetY,
        moved: false,
      };
      // raise to top
      graph.nodes.splice(graph.nodes.indexOf(n), 1);
      graph.nodes.push(n);
    } else {
      // dragging a collapsed group moves all its members together
      drag = { type: "pseudo", pseudo: hit.pseudo, wx, wy, moved: false };
    }
    canvas.setPointerCapture(ev.pointerId);
  };

  const onPointerMove = (ev: PointerEvent) => {
    pointer = { sx: ev.offsetX, sy: ev.offsetY };
    if (!drag) {
      canvas.style.cursor = gripHitAt(ev.offsetX, ev.offsetY)
        ? "nwse-resize"
        : "grab";
    }
    if (drag) {
      const [wx, wy] = screenToWorld(view, ev.offsetX, ev.offsetY);
      // rg-ui: every element snaps to the minor readable grid → dense layouts
      const step = gridLevels(view.k, rule.minGridPx, rule.ladder)[1]!.step;
      if (drag.type === "resize") {
        const n = drag.node;
        const [wx, wy] = screenToWorld(view, ev.offsetX, ev.offsetY);
        // grid-snap the corner, respect minimums, stop at neighbors
        const minW = 96;
        const wantW = Math.max(minW, snap(wx - n.x, step));
        const wantH = Math.max(nodeMinHeight(n), snap(wy - n.y, step));
        const { w, h } = clampSize(n, wantW, wantH, graph.nodes);
        if (w !== n.w || h !== nodeHeight(n)) {
          n.w = w;
          n.h = h;
          drag.moved = true;
          options.onNodeResize?.(n.id, { w, h: nodeHeight(n) });
        }
      } else if (drag.type === "panelItem") {
        drag.sx = ev.offsetX;
        drag.sy = ev.offsetY;
        if (
          Math.hypot(ev.offsetX - drag.downX, ev.offsetY - drag.downY) >= 4
        )
          drag.moved = true;
      } else if (drag.type === "marquee") {
        drag.x1 = ev.offsetX;
        drag.y1 = ev.offsetY;
      } else if (drag.type === "wire") {
        drag.toSx = ev.offsetX;
        drag.toSy = ev.offsetY;
      } else if (drag.type === "node") {
        if (drag.node.pinned) return; // pinned nodes do not move
        // 一格一物: overlap is not allowed — grid-snap first, then push out
        // to flush contact against whatever the node would cover
        const { x: nx, y: ny } = resolveOverlap(
          drag.node,
          snap(wx - drag.dx, step),
          snap(wy - drag.dy, step),
          graph.nodes,
          { alignSnap: rule.alignSnapPx / view.k, direction: rule.direction },
        );
        if (nx !== drag.node.x || ny !== drag.node.y) {
          drag.node.x = nx;
          drag.node.y = ny;
          drag.moved = true;
          options.onNodeMove?.(drag.node.id, { x: nx, y: ny });
        }
      } else {
        // a cluster with a pinned member is bolted down
        if (drag.pseudo.members.some((n) => n.pinned)) return;
        const ddx = snap(wx - drag.wx, step);
        const ddy = snap(wy - drag.wy, step);
        if (ddx || ddy) {
          for (const n of drag.pseudo.members) {
            n.x += ddx;
            n.y += ddy;
            options.onNodeMove?.(n.id, { x: n.x, y: n.y });
          }
          drag.pseudo.cx += ddx;
          drag.pseudo.cy += ddy;
          drag.wx += ddx;
          drag.wy += ddy;
          drag.moved = true;
        }
      }
    }
    invalidate();
  };

  /** set when a right-button marquee actually moved (suppresses the menu) */
  let rightDragMoved = false;

  const onPointerUp = (ev: PointerEvent) => {
    if (!drag) return;
    if (drag.type === "resize") {
      if (drag.moved)
        options.onNodeResizeEnd?.(drag.node.id, {
          w: drag.node.w,
          h: nodeHeight(drag.node),
        });
      drag = null;
      invalidate();
      return;
    }
    if (drag.type === "panelItem") {
      const overPanel = panelHitAt(lastPanelRects, ev.offsetX, ev.offsetY);
      if (!drag.moved) {
        drag.panel.onItemClick?.(drag.item, { x: ev.offsetX, y: ev.offsetY });
      } else if (!overPanel) {
        const [wx, wy] = screenToWorld(view, ev.offsetX, ev.offsetY);
        drag.panel.onItemDrop?.(drag.item, {
          world: { x: wx, y: wy },
          screen: { x: ev.offsetX, y: ev.offsetY },
        });
      }
      drag = null;
      invalidate();
      return;
    }
    if (drag.type === "marquee") {
      const moved =
        Math.hypot(drag.x1 - drag.x0, drag.y1 - drag.y0) >= 4;
      if (!moved) {
        // empty-canvas CLICK: wire click, else clear selection; right-button
        // click falls through to the contextmenu event
        if (drag.button === 0) {
          const e = edgeAt(ev.offsetX, ev.offsetY);
          if (e) options.onEdgeClick?.(e, { x: ev.offsetX, y: ev.offsetY });
          else if (selection.size) applySelection(new Set());
        }
        drag = null;
        invalidate();
        return;
      }
      if (drag.button === 2) rightDragMoved = true;
      const [wx0, wy0] = screenToWorld(view, Math.min(drag.x0, drag.x1), Math.min(drag.y0, drag.y1));
      const [wx1, wy1] = screenToWorld(view, Math.max(drag.x0, drag.x1), Math.max(drag.y0, drag.y1));
      const picked = new Set(
        (lastRg?.nodes ?? graph.nodes)
          .filter(
            (n) =>
              n.x < wx1 &&
              n.x + n.w > wx0 &&
              n.y < wy1 &&
              n.y + nodeHeight(n) > wy0,
          )
          .map((n) => n.id),
      );
      applySelection(picked);
      drag = null;
      return;
    }
    if (drag.type === "wire") {
      const target = portAt(ev.offsetX, ev.offsetY);
      if (target && validConnection(drag.from, target)) {
        const [from, to] =
          drag.from.ref.side === "out"
            ? [drag.from.ref, target.ref]
            : [target.ref, drag.from.ref];
        options.onConnect?.(from, to);
      } else if (!target) {
        // released on empty canvas — let the host offer "create node here"
        const [wx, wy] = screenToWorld(view, ev.offsetX, ev.offsetY);
        options.onConnectEnd?.(drag.from.ref, {
          screen: { x: ev.offsetX, y: ev.offsetY },
          world: { x: wx, y: wy },
        });
      }
    } else if (drag.type === "node") {
      if (drag.moved) {
        options.onNodeMoveEnd?.(drag.node.id, {
          x: drag.node.x,
          y: drag.node.y,
        });
      } else if (
        Math.hypot(ev.offsetX - drag.downX, ev.offsetY - drag.downY) < 4
      ) {
        applySelection(new Set([drag.node.id]));
        options.onNodeClick?.(drag.node.id, { x: ev.offsetX, y: ev.offsetY });
      }
    } else if (drag.type === "pseudo" && drag.moved) {
      // pseudo drags report every member's final position
      for (const n of drag.pseudo.members)
        options.onNodeMoveEnd?.(n.id, { x: n.x, y: n.y });
    }
    drag = null;
    invalidate();
  };

  const onContextMenu = (ev: MouseEvent) => {
    if (rightDragMoved) {
      // a right-button box select just ended — not a menu
      rightDragMoved = false;
      ev.preventDefault();
      return;
    }
    const hit = hitAt(ev.offsetX, ev.offsetY);
    if (hit?.type === "node" && options.onNodeContextMenu) {
      ev.preventDefault();
      options.onNodeContextMenu(hit.node.id, {
        x: ev.offsetX,
        y: ev.offsetY,
      });
      return;
    }
    if (!hit) {
      const e = edgeAt(ev.offsetX, ev.offsetY);
      if (e && options.onEdgeContextMenu) {
        ev.preventDefault();
        options.onEdgeContextMenu(e, { x: ev.offsetX, y: ev.offsetY });
        return;
      }
      if (!e && options.onCanvasContextMenu) {
        ev.preventDefault();
        const [wx, wy] = screenToWorld(view, ev.offsetX, ev.offsetY);
        options.onCanvasContextMenu(
          { x: ev.offsetX, y: ev.offsetY },
          { x: wx, y: wy },
        );
      }
    }
  };

  canvas.addEventListener("pointerdown", onPointerDown);
  canvas.addEventListener("pointermove", onPointerMove);
  canvas.addEventListener("pointerup", onPointerUp);
  canvas.addEventListener("contextmenu", onContextMenu);

  // --- pan / zoom (figma-style input by default) --------------------------

  const input = options.input ?? "figma";
  let spaceHeld = false;
  const onKeyDown = (ev: KeyboardEvent) => {
    if (ev.code === "Space" && !ev.repeat) {
      const t = ev.target as HTMLElement | null;
      if (t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return;
      spaceHeld = true;
      canvas.style.cursor = "grab";
    }
  };
  const onKeyUp = (ev: KeyboardEvent) => {
    if (ev.code === "Space") spaceHeld = false;
  };
  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", onKeyUp);

  /** figma wheel: ctrl/pinch + discrete mouse wheel = zoom; 2-finger = pan */
  const onWheel = (ev: WheelEvent) => {
    if (input !== "figma") return; // classic: d3 handles wheel
    ev.preventDefault();
    const isZoom =
      ev.ctrlKey || // pinch gesture or ctrl+wheel
      ev.deltaMode !== 0 || // line/page mode = real mouse wheel
      (ev.deltaX === 0 &&
        Number.isInteger(ev.deltaY) &&
        Math.abs(ev.deltaY) >= 50); // discrete integer steps = mouse wheel
    if (isZoom) {
      // clamp per-event delta so pinch (small fractional deltas) stays
      // smooth while discrete mouse-wheel ticks (±120) don't explode
      const d = Math.max(
        -40,
        Math.min(40, ev.deltaY * (ev.deltaMode === 0 ? 1 : 20)),
      );
      const factor = Math.exp(-d * 0.012);
      const k = Math.min(1e6, Math.max(1e-6, view.k * factor));
      // keep the world point under the cursor invariant
      const [wx, wy] = screenToWorld(view, ev.offsetX, ev.offsetY);
      sel.call(
        zoomBehavior.transform,
        zoomIdentity
          .translate(ev.offsetX - wx * k, ev.offsetY - wy * k)
          .scale(k),
      );
    } else {
      // touchpad two-finger scroll pans both axes
      sel.call(
        zoomBehavior.transform,
        zoomIdentity
          .translate(view.x - ev.deltaX, view.y - ev.deltaY)
          .scale(view.k),
      );
    }
  };
  canvas.addEventListener("wheel", onWheel, { passive: false });

  const zoomBehavior = zoom<HTMLCanvasElement, unknown>()
    .scaleExtent([1e-6, 1e6])
    .filter((ev: MouseEvent | WheelEvent) => {
      if (ev.type === "wheel")
        // figma: wheel fully custom (see onWheel); classic: d3 zooms
        return input !== "figma";
      const me = ev as MouseEvent;
      if (input === "figma" && me.type === "mousedown") {
        // pan only via middle button or space+left-drag
        if (me.button === 1) return true;
        if (me.button === 0 && spaceHeld)
          return !panelHitAt(lastPanelRects, me.offsetX, me.offsetY);
        return false;
      }
      if (me.shiftKey) return false; // shift+drag = box select
      if (indicatorAt(me.offsetX, me.offsetY)) return false; // indicator click
      if (panelHitAt(lastPanelRects, me.offsetX, me.offsetY)) return false;
      if (gripHitAt(me.offsetX, me.offsetY)) return false; // resize grip
      if (
        (options.onConnect || options.isValidConnection) &&
        portAt(me.offsetX, me.offsetY)
      )
        return false; // wire drag wins
      return !hitAt(me.offsetX, me.offsetY);
    })
    .on("zoom", (ev: D3ZoomEvent<HTMLCanvasElement, unknown>) => {
      view = { x: ev.transform.x, y: ev.transform.y, k: ev.transform.k };
      invalidate();
    });

  const sel = select(canvas);
  sel.call(zoomBehavior);
  if (input === "figma") sel.on("dblclick.zoom", null);
  sel.call(
    zoomBehavior.transform,
    options.view
      ? zoomIdentity
          .translate(options.view.x, options.view.y)
          .scale(options.view.k)
      : // default: world origin at the viewport center
        zoomIdentity.translate(
          canvas.clientWidth / 2,
          canvas.clientHeight / 2,
        ),
  );

  const ro = new ResizeObserver(() => {
    renderer.resize();
    gpu?.resize();
    invalidate();
  });
  ro.observe(canvas);

  invalidate();

  return {
    canvas,
    get view() {
      return view;
    },
    get rendererKind() {
      return rendererKind;
    },
    rule,
    get graph() {
      return graph;
    },
    set graph(g: Graph) {
      graph = g;
      invalidate();
    },
    setGraph(g: Graph) {
      graph = g;
      invalidate();
    },
    get selection() {
      return [...selection];
    },
    setSelection(nodeIds: string[]) {
      applySelection(new Set(nodeIds));
    },
    setPanels(next: Panel[]) {
      panels = next;
      invalidate();
    },
    setNodeOverlay(
      nodeId: string,
      overlay: HTMLElement | NodeHtmlOverlay | null,
    ) {
      const n = graph.nodes.find((m) => m.id === nodeId);
      if (!n) {
        console.warn(`[rgui] setNodeOverlay: unknown node "${nodeId}"`);
        return;
      }
      n.overlay = overlay
        ? overlay instanceof HTMLElement
          ? { el: overlay }
          : overlay
        : undefined;
      invalidate();
    },
    autoLayout(opts?: LayoutOptions & { animate?: boolean }) {
      const target = layoutGraph(graph, opts);
      const moved = [...target].filter(([id, p]) => {
        const n = graph.nodes.find((m) => m.id === id);
        return n && (n.x !== p.x || n.y !== p.y);
      });
      if (!moved.length) return;
      const finish = () => {
        for (const [id, p] of moved) {
          const n = graph.nodes.find((m) => m.id === id)!;
          n.x = p.x;
          n.y = p.y;
          options.onNodeMoveEnd?.(id, p);
        }
        invalidate();
      };
      if (opts?.animate === false) return finish();
      const start = new Map(
        moved.map(([id]) => {
          const n = graph.nodes.find((m) => m.id === id)!;
          return [id, { x: n.x, y: n.y }] as const;
        }),
      );
      const t0 = performance.now();
      const dur = 300;
      const stepFrame = (now: number) => {
        const u = Math.min(1, (now - t0) / dur);
        const e = u < 0.5 ? 2 * u * u : 1 - (-2 * u + 2) ** 2 / 2;
        for (const [id, p] of moved) {
          const n = graph.nodes.find((m) => m.id === id)!;
          const s0 = start.get(id)!;
          n.x = s0.x + (p.x - s0.x) * e;
          n.y = s0.y + (p.y - s0.y) * e;
        }
        invalidate();
        if (u < 1) requestAnimationFrame(stepFrame);
        else finish();
      };
      requestAnimationFrame(stepFrame);
    },
    resizeNode(nodeId: string, size: { w?: number; h?: number }) {
      const n = graph.nodes.find((m) => m.id === nodeId);
      if (!n) return;
      const { w, h } = clampSize(
        n,
        Math.max(96, size.w ?? n.w),
        Math.max(nodeMinHeight(n), size.h ?? nodeHeight(n)),
        graph.nodes,
      );
      n.w = w;
      n.h = h;
      invalidate();
    },
    portScreenPos(nodeId: string, portId: string, side: "in" | "out") {
      const nodes = lastRg?.nodes ?? graph.nodes;
      const layout = computePortLayout(graph, nodes, flushSegments(nodes));
      const pl = layout.get(`${nodeId}/${side}/${portId}`);
      if (!pl) return null;
      const [x, y] = worldToScreenXY(pl.x, pl.y);
      return { x, y, edge: pl.edge, hidden: pl.hidden };
    },
    edgeMidScreen(edge: {
      from: { node: string; port: string };
      to: { node: string; port: string };
    }) {
      const nodes = lastRg?.nodes ?? graph.nodes;
      const segments = flushSegments(nodes);
      // dissolved into a seam (direct contact) → not drawn as a wire
      if (
        flushPairKeys(segments).has(
          [edge.from.node, edge.to.node].sort().join("|"),
        )
      )
        return null;
      const layout = computePortLayout(graph, nodes, segments);
      const pf = layout.get(`${edge.from.node}/out/${edge.from.port}`);
      const pt = layout.get(`${edge.to.node}/in/${edge.to.port}`);
      if (!pf || !pt || pf.hidden || pt.hidden) return null;
      const [x0, y0] = worldToScreenXY(pf.x, pf.y);
      const [x1, y1] = worldToScreenXY(pt.x, pt.y);
      const dx = Math.max(40 * view.k, Math.abs(x1 - x0) * 0.5);
      const cx0 = x0 + (pf.edge === "right" ? 1 : -1) * dx;
      const cx1 = x1 + (pt.edge === "right" ? 1 : -1) * dx;
      // cubic bezier at u=0.5 (controls' y equal endpoint y)
      return {
        x: 0.125 * (x0 + x1) + 0.375 * (cx0 + cx1),
        y: 0.5 * (y0 + y1),
      };
    },
    setView(v: ViewTransform) {
      sel.call(
        zoomBehavior.transform,
        zoomIdentity.translate(v.x, v.y).scale(v.k),
      );
    },
    fitView(paddingPx = 48) {
      if (!graph.nodes.length) return;
      const x0 = Math.min(...graph.nodes.map((n) => n.x));
      const y0 = Math.min(...graph.nodes.map((n) => n.y));
      const x1 = Math.max(...graph.nodes.map((n) => n.x + n.w));
      const y1 = Math.max(...graph.nodes.map((n) => n.y + nodeHeight(n)));
      const W = canvas.clientWidth;
      const H = canvas.clientHeight;
      const k = Math.min(
        (W - 2 * paddingPx) / (x1 - x0),
        (H - 2 * paddingPx) / (y1 - y0),
        1e6,
      );
      const cx = (x0 + x1) / 2;
      const cy = (y0 + y1) / 2;
      sel.call(
        zoomBehavior.transform,
        zoomIdentity.translate(W / 2 - cx * k, H / 2 - cy * k).scale(k),
      );
    },
    invalidate,
    destroy() {
      destroyed = true;
      gpu?.destroy();
      underlay?.remove();
      overlays.destroy();
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      canvas.removeEventListener("wheel", onWheel);
      if (raf) cancelAnimationFrame(raf);
      ro.disconnect();
      sel.on(".zoom", null);
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointerup", onPointerUp);
      canvas.removeEventListener("contextmenu", onContextMenu);
    },
  };
}
