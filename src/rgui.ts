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
} from "./render/canvas2d";
import { drawGraph } from "./render/graphLayer";
import { nodeHeight, type Graph, type GraphNode } from "./core/graph";
import { pseudoRect, type PseudoNode, type RenderGraph } from "./core/lod";
import { resolveRule, type RgRule } from "./core/rule";
import {
  gridLevels,
  screenToWorld,
  snap,
  type ViewTransform,
} from "./core/grid";

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

  let drag:
    | { type: "node"; node: GraphNode; dx: number; dy: number }
    | { type: "pseudo"; pseudo: PseudoNode; wx: number; wy: number }
    | null = null;

  const onPointerDown = (ev: PointerEvent) => {
    const hit = hitAt(ev.offsetX, ev.offsetY);
    if (!hit) return;
    const [wx, wy] = screenToWorld(view, ev.offsetX, ev.offsetY);
    if (hit.type === "node") {
      const n = hit.node;
      drag = { type: "node", node: n, dx: wx - n.x, dy: wy - n.y };
      // raise to top
      graph.nodes.splice(graph.nodes.indexOf(n), 1);
      graph.nodes.push(n);
    } else {
      // dragging a collapsed group moves all its members together
      drag = { type: "pseudo", pseudo: hit.pseudo, wx, wy };
    }
    canvas.setPointerCapture(ev.pointerId);
  };
  const onPointerMove = (ev: PointerEvent) => {
    pointer = { sx: ev.offsetX, sy: ev.offsetY };
    if (drag) {
      const [wx, wy] = screenToWorld(view, ev.offsetX, ev.offsetY);
      // rg-ui: every element snaps to the minor readable grid → dense layouts
      const step = gridLevels(view.k, rule.minGridPx, rule.ladder)[1]!.step;
      if (drag.type === "node") {
        drag.node.x = snap(wx - drag.dx, step);
        drag.node.y = snap(wy - drag.dy, step);
      } else {
        const ddx = snap(wx - drag.wx, step);
        const ddy = snap(wy - drag.wy, step);
        if (ddx || ddy) {
          for (const n of drag.pseudo.members) {
            n.x += ddx;
            n.y += ddy;
          }
          drag.pseudo.cx += ddx;
          drag.pseudo.cy += ddy;
          drag.wx += ddx;
          drag.wy += ddy;
        }
      }
    }
    invalidate();
  };
  const onPointerUp = () => (drag = null);

  canvas.addEventListener("pointerdown", onPointerDown);
  canvas.addEventListener("pointermove", onPointerMove);
  canvas.addEventListener("pointerup", onPointerUp);

  // --- pan / zoom (d3) ----------------------------------------------------

  const zoomBehavior = zoom<HTMLCanvasElement, unknown>()
    .scaleExtent([1e-6, 1e6])
    // let node drags win over panning; wheel-zoom always allowed
    .filter((ev: MouseEvent | WheelEvent) => {
      if (ev.type === "wheel") return true;
      const me = ev as MouseEvent;
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
    },
  };
}
