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
  KIND_COLOR,
  type OffscreenIndicator,
} from "./render/graphLayer.js";
import {
  inputPortPos,
  nodeHeight,
  outputPortPos,
  type Edge,
  type Graph,
  type GraphNode,
  type Port,
} from "./core/graph.js";
import { pseudoRect, type PseudoNode, type RenderGraph } from "./core/lod.js";
import {
  computePortLayout,
  flushComponents,
  flushSegments,
  resolveOverlap,
} from "./core/pack.js";
import { resolveRule, type RgRule } from "./core/rule.js";
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

  const renderer = createCanvas2DRenderer(canvas, [
    createGridDotsLayer(rule),
    ...(options.layers ?? []),
    (ctx, t) => (lastRg = drawGraph(ctx, t, graph, rule)),
    (ctx, t) => drawSelectionLayer(ctx, t),
    (ctx, t, size) => {
      lastIndicators = lastRg
        ? drawOffscreenIndicators(ctx, t, lastRg, size, rule)
        : [];
    },
    (ctx, t) => drawGhostWire(ctx, t),
  ]);

  let view: ViewTransform = options.view ?? { x: 0, y: 0, k: 1 };

  let raf = 0;
  let destroyed = false;
  function invalidate() {
    if (raf || destroyed) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      renderer.render(view);
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
      `<span class="dim"> dpr </span>${devicePixelRatio}\n` +
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
    | { type: "marquee"; x0: number; y0: number; x1: number; y1: number }
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

  const onPointerDown = (ev: PointerEvent) => {
    // off-screen indicators are UI chrome on top: click = go to the node
    const ind = indicatorAt(ev.offsetX, ev.offsetY);
    if (ind) {
      panTo(ind.cx, ind.cy);
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
      emptyDown = { x: ev.offsetX, y: ev.offsetY };
      if (ev.shiftKey) {
        // box select
        drag = {
          type: "marquee",
          x0: ev.offsetX,
          y0: ev.offsetY,
          x1: ev.offsetX,
          y1: ev.offsetY,
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
    if (drag) {
      const [wx, wy] = screenToWorld(view, ev.offsetX, ev.offsetY);
      // rg-ui: every element snaps to the minor readable grid → dense layouts
      const step = gridLevels(view.k, rule.minGridPx, rule.ladder)[1]!.step;
      if (drag.type === "marquee") {
        drag.x1 = ev.offsetX;
        drag.y1 = ev.offsetY;
      } else if (drag.type === "wire") {
        drag.toSx = ev.offsetX;
        drag.toSy = ev.offsetY;
      } else if (drag.type === "node") {
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

  let emptyDown: { x: number; y: number } | null = null;

  const onPointerUp = (ev: PointerEvent) => {
    if (!drag && emptyDown) {
      // click (not pan) on empty canvas: wire click or clear selection
      if (Math.hypot(ev.offsetX - emptyDown.x, ev.offsetY - emptyDown.y) < 4) {
        const e = edgeAt(ev.offsetX, ev.offsetY);
        if (e) options.onEdgeClick?.(e, { x: ev.offsetX, y: ev.offsetY });
        else if (selection.size) applySelection(new Set());
      }
      emptyDown = null;
      return;
    }
    emptyDown = null;
    if (!drag) return;
    if (drag.type === "marquee") {
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
    const hit = hitAt(ev.offsetX, ev.offsetY);
    if (hit?.type === "node" && options.onNodeContextMenu) {
      ev.preventDefault();
      options.onNodeContextMenu(hit.node.id, {
        x: ev.offsetX,
        y: ev.offsetY,
      });
      return;
    }
    if (!hit && options.onEdgeContextMenu) {
      const e = edgeAt(ev.offsetX, ev.offsetY);
      if (e) {
        ev.preventDefault();
        options.onEdgeContextMenu(e, { x: ev.offsetX, y: ev.offsetY });
      }
    }
  };

  canvas.addEventListener("pointerdown", onPointerDown);
  canvas.addEventListener("pointermove", onPointerMove);
  canvas.addEventListener("pointerup", onPointerUp);
  canvas.addEventListener("contextmenu", onContextMenu);

  // --- pan / zoom (d3) ----------------------------------------------------

  const zoomBehavior = zoom<HTMLCanvasElement, unknown>()
    .scaleExtent([1e-6, 1e6])
    // let node drags win over panning; wheel-zoom always allowed
    .filter((ev: MouseEvent | WheelEvent) => {
      if (ev.type === "wheel") return true;
      const me = ev as MouseEvent;
      if (me.shiftKey) return false; // shift+drag = box select
      if (indicatorAt(me.offsetX, me.offsetY)) return false; // indicator click
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
    invalidate();
  });
  ro.observe(canvas);

  invalidate();

  return {
    canvas,
    get view() {
      return view;
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
      const comp = flushComponents(nodes, segments);
      // dissolved inside one flush stack → not drawn (matches the renderer)
      if (comp.get(edge.from.node) === comp.get(edge.to.node)) return null;
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
