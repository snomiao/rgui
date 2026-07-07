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
import { drawGraph, KIND_COLOR } from "./render/graphLayer.js";
import {
  inputPortPos,
  nodeHeight,
  outputPortPos,
  type Graph,
  type GraphNode,
  type Port,
} from "./core/graph.js";
import { pseudoRect, type PseudoNode, type RenderGraph } from "./core/lod.js";
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

  const renderer = createCanvas2DRenderer(canvas, [
    createGridDotsLayer(rule),
    ...(options.layers ?? []),
    (ctx, t) => (lastRg = drawGraph(ctx, t, graph, rule)),
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
    // only real (expanded) nodes expose wirable ports
    for (const n of lastRg?.nodes ?? graph.nodes) {
      for (let i = 0; i < n.inputs.length; i++) {
        const [wx, wy] = inputPortPos(n, i);
        const [px, py] = worldToScreenXY(wx, wy);
        if (Math.hypot(px - sx, py - sy) <= PORT_HIT_PX)
          return {
            ref: { node: n.id, port: n.inputs[i]!.id, side: "in" },
            port: n.inputs[i]!,
            wx,
            wy,
          };
      }
      for (let i = 0; i < n.outputs.length; i++) {
        const [wx, wy] = outputPortPos(n, i);
        const [px, py] = worldToScreenXY(wx, wy);
        if (Math.hypot(px - sx, py - sy) <= PORT_HIT_PX)
          return {
            ref: { node: n.id, port: n.outputs[i]!.id, side: "out" },
            port: n.outputs[i]!,
            wx,
            wy,
          };
      }
    }
    return null;
  }

  function worldToScreenXY(wx: number, wy: number): [number, number] {
    return [wx * view.k + view.x, wy * view.k + view.y];
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
    // ports win over node bodies (they overlap the node edge)
    const ph = portAt(ev.offsetX, ev.offsetY);
    if (ph && (options.onConnect || options.isValidConnection)) {
      drag = { type: "wire", from: ph, toSx: ev.offsetX, toSy: ev.offsetY };
      canvas.setPointerCapture(ev.pointerId);
      return;
    }
    const hit = hitAt(ev.offsetX, ev.offsetY);
    if (!hit) return;
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
      if (drag.type === "wire") {
        drag.toSx = ev.offsetX;
        drag.toSy = ev.offsetY;
      } else if (drag.type === "node") {
        const nx = snap(wx - drag.dx, step);
        const ny = snap(wy - drag.dy, step);
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

  const onPointerUp = (ev: PointerEvent) => {
    if (!drag) return;
    if (drag.type === "wire") {
      const target = portAt(ev.offsetX, ev.offsetY);
      if (target && validConnection(drag.from, target)) {
        const [from, to] =
          drag.from.ref.side === "out"
            ? [drag.from.ref, target.ref]
            : [target.ref, drag.from.ref];
        options.onConnect?.(from, to);
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
