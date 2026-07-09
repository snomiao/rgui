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
  kindColor,
  type OffscreenIndicator,
} from "./render/graphLayer.js";
import {
  drawPanelDragGhost,
  drawPanels,
  panelHitAt,
  panelLayout,
  panelSnap,
  PANEL,
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
  containmentOf,
  contentScale,
  descendantsOf,
  inputPortPos,
  nodeHeight,
  nodeMinHeight,
  nodeMinWidth,
  outputPortPos,
  type Edge,
  type Graph,
  type GraphNode,
  type Port,
} from "./core/graph.js";
import { pseudoRect, type PseudoNode, type RenderGraph } from "./core/lod.js";
import { AccModel2D } from "./core/accModel.js";
import {
  clampSize,
  computePortLayout,
  flushComponents,
  flushPairKeys,
  flushSegments,
  resolveOverlap,
} from "./core/pack.js";
import { layoutGraph, type LayoutOptions } from "./core/layout.js";
import { resolveRule, type RgRule } from "./core/rule.js";
import {
  resolveTheme,
  withAlpha,
  type RgTheme,
  type RgThemeInput,
} from "./core/theme.js";
import type { SummarizeFn } from "./core/summary.js";
import {
  gridLevels,
  screenToWorld,
  snap,
  sizeLayerStep,
  snapSizeRadix,
  type ViewTransform,
} from "./core/grid.js";

/** magnification band a shift-drag rescale may reach */
export const MIN_SCALE = 0.25;
export const MAX_SCALE = 8;

export interface RguiOptions {
  /** the node graph to render (mutated in place by dragging) */
  graph?: Graph;
  /** customize every readability threshold for your use case */
  rule?: Partial<RgRule>;
  /**
   * chrome colors (default "dark"): "dark" | "light" | a partial palette
   * over a base ({ base: "light", accent: "#e91e63" }). Both built-ins keep
   * the mascot field-arrow pair — purple ⊙ toward the viewer, gold ⊗ away.
   * Swap live with viewer.setTheme().
   */
  theme?: RgThemeInput;
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
  /**
   * fires during a corner-grip resize (grid-snapped, overlap-clamped).
   * `scale` is the node's content scale — it only moves in the shift-drag
   * RESCALE mode, where the node magnifies instead of reflowing.
   */
  onNodeResize?: (
    nodeId: string,
    size: { w: number; h: number; scale: number },
  ) => void;
  /** fires once when a corner-grip resize ends */
  onNodeResizeEnd?: (
    nodeId: string,
    size: { w: number; h: number; scale: number },
  ) => void;
  /**
   * screen-anchored palettes/panels drawn as canvas chrome — items support
   * click-to-add (Panel.onItemClick) and drag-onto-canvas (Panel.onItemDrop)
   */
  panels?: Panel[];
  /**
   * a panel was moved by a header drag (fires on release): its anchor is
   * now an explicit screen position — persist it (e.g. localStorage) and
   * pass it back via Panel.anchor on the next run. While dragging, panels
   * snap to the viewport margins and flush against other panels; flush
   * boundaries dissolve like snapped nodes.
   */
  onPanelMove?: (panel: Panel, anchor: { x: number; y: number }) => void;
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
   * cap the canvas backing-store scale (default: device pixel ratio).
   * Raster cost grows with dpr² — 1.5 is a good perf/sharpness trade on
   * retina displays with busy pages.
   */
  maxDpr?: number;
  /**
   * canvas background fill; false = transparent (page background shows
   * through — lets hosts layer DOM behind the graph)
   */
  background?: string | false;
  /**
   * input preset (default "figma"):
   * - figma: 2-finger scroll = pan · pinch / ctrl+wheel / mouse wheel = zoom ·
   *   plain or right drag on empty = box select · space+drag / middle drag = pan
   * - classic: wheel = zoom · plain drag on empty = pan · shift+drag = box select
   */
  input?: "figma" | "classic";
  /**
   * keyboard navigation (default true), modelled on CapsLockX's cursor accel:
   * WASD pans, R/F zoom in/out (time-based acceleration — hold to speed up),
   * N/P (or Tab / Shift+Tab) cycle focus between nodes, and ? toggles a
   * shortcuts panel. Keys act only while the pointer is over the canvas (so a
   * host app's own hotkeys keep working elsewhere) and never while typing in
   * an input/textarea. Set false to disable entirely.
   */
  keyboard?: boolean;
  /**
   * keyboard pan / zoom acceleration rates (units per first-second of hold),
   * fed to the CapsLockX AccModel. Defaults mirror CapsLockX: pan 1600, zoom
   * 1600. Larger = faster.
   */
  keyboardSpeed?: { pan?: number; zoom?: number };
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
  /** viewport roll in radians (about the viewport center) */
  readonly rotation: number;
  /** full 3-D orientation of the graph plane */
  readonly rotation3: { yaw: number; pitch: number; roll: number };
  /** rotate the whole viewport in-plane (roll only; see setRotation3) */
  setRotation(rad: number, opts?: { animate?: boolean }): void;
  /**
   * orient the graph plane in 3-D (orthographic): yaw/pitch tilt it,
   * foreshortened nodes visually converge and the LOD merges them —
   * a pure rendering trick, base positions never change
   */
  setRotation3(
    target: { yaw?: number; pitch?: number; roll?: number },
    opts?: { animate?: boolean },
  ): void;
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
   * programmatic RESCALE: magnify the node about its top-left corner,
   * w/h ratio preserved and every interior metric scaled with it — the
   * shift+grip drag's endpoint, reachable from code.
   */
  rescaleNode(nodeId: string, scale: number): void;
  /**
   * auto-layout by connection optimization (layered + barycenter). Pinned
   * nodes stay put. Animates ~300ms, then fires onNodeMoveEnd per moved node
   so hosts can broadcast the new positions.
   */
  autoLayout(opts?: LayoutOptions & { animate?: boolean }): void;
  /**
   * snap every node — POSITION and SIZE — to the MAIN visible grid at the
   * current scale; one call makes a generated/imported graph obey the snap
   * rule. Fires onNodeMoveEnd/onNodeResizeEnd per changed node (host
   * broadcast) unless silent.
   */
  snapGraph(opts?: { silent?: boolean }): void;
  /**
   * screen midpoint of a wire's bezier as currently drawn — null if the
   * wire is dissolved (inside a flush stack) or an endpoint is collapsed.
   */
  edgeMidScreen(edge: {
    from: { node: string; port: string };
    to: { node: string; port: string };
  }): { x: number; y: number } | null;
  /** the resolved active theme (live object — do not mutate; use setTheme) */
  readonly theme: RgTheme;
  /** swap the chrome palette live: "dark" | "light" | partial over a base */
  setTheme(theme: RgThemeInput): void;
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
  // one mutable theme object for the viewer's lifetime: layers/renderers
  // close over it and read colors per frame, so setTheme = assign + redraw
  const theme = resolveTheme(options.theme);
  // an explicit background option wins over the theme (incl. false)
  const themeBg = () =>
    options.background === undefined ? theme.background : options.background;
  let graph: Graph = options.graph ?? { nodes: [], edges: [] };
  let lastRg: RenderGraph | null = null;
  let lastBuildK = Infinity;

  let lastIndicators: OffscreenIndicator[] = [];
  let panels: Panel[] = options.panels ?? [];
  let lastPanelRects: PanelRect[] = [];

  // --- viewport 3-D rotation (orthographic, about the viewport center) ----
  // The graph plane rotates in 3-D (yaw/pitch/roll); its orthographic
  // projection onto the screen is a plain 2x2 affine matrix A, so both
  // renderers and (inverted) pointer input stay exact. Foreshortening makes
  // nodes visually converge, and the LOD metric sees it — merging is a pure
  // rendering trick; base node positions never change.
  const rot3 = { yaw: 0, pitch: 0, roll: 0 };
  let A: readonly [number, number, number, number] = [1, 0, 0, 1];
  let Ainv: readonly [number, number, number, number] = [1, 0, 0, 1];
  let Zcol: readonly [number, number] = [0, 0];
  let rotActive = false;
  function updateRotation() {
    const { yaw, pitch, roll } = rot3;
    rotActive = !!(yaw || pitch || roll);
    const cy = Math.cos(yaw);
    const sy = Math.sin(yaw);
    const cx = Math.cos(pitch);
    const sx = Math.sin(pitch);
    const cz = Math.cos(roll);
    const sz = Math.sin(roll);
    // R = Rz(roll) · Rx(pitch) · Ry(yaw); screen linear part = rows 0,1 ×
    // cols 0,1 (graph plane is z = 0)
    const a = cz * cy - sz * sx * sy; // R00
    const b = -sz * cx; // R01
    const c = sz * cy + cz * sx * sy; // R10
    const d = cz * cx; // R11
    A = [a, b, c, d];
    // z column of R (first two rows) — how depth shifts projected positions
    const zx = sy * cz + sx * cy * sz;
    const zy = sy * sz - sx * cy * cz;
    Zcol = [zx, zy];
    const det = a * d - b * c;
    const inv = Math.abs(det) < 0.05 ? (det < 0 ? -20 : 20) : 1 / det;
    Ainv = [d * inv, -b * inv, -c * inv, a * inv];
  }
  // the VIEW is always 2-D (billboard model): pointer coords are used as-is
  const toView = (sx: number, sy: number) => [sx, sy] as const;
  const fromView = (vx: number, vy: number) => [vx, vy] as const;
  /**
   * the grid field's 3-D base vector = R · (0,0,1): dots keep their screen
   * positions, arrows lean along the lateral part; z < 0 flips ⊙ → ⊗
   */
  function fieldVec3(): { x: number; y: number; z: number } {
    const { yaw, pitch, roll } = rot3;
    const cy = Math.cos(yaw);
    const sy = Math.sin(yaw);
    const cx = Math.cos(pitch);
    const sx = Math.sin(pitch);
    const cz = Math.cos(roll);
    const sz = Math.sin(roll);
    // Rz(roll) · Rx(pitch) · Ry(yaw) · e3
    const x0 = sy;
    const y0 = -sx * cy;
    const z0 = cx * cy;
    return { x: x0 * cz - y0 * sz, y: x0 * sz + y0 * cz, z: z0 };
  }

  /**
   * BILLBOARD projection: node POSITIONS rotate in 3-D, nodes themselves
   * always render as upright 2-D cards. Project a world point through the
   * rotation about the world point at the viewport center.
   */
  function projectWorldPt(
    x: number,
    y: number,
    z = 0,
  ): readonly [number, number] {
    const [cwx, cwy] = screenToWorld(
      view,
      canvas.clientWidth / 2,
      canvas.clientHeight / 2,
    );
    const dx = x - cwx;
    const dy = y - cwy;
    return [
      cwx + A[0] * dx + A[1] * dy + Zcol[0] * z,
      cwy + A[2] * dx + A[3] * dy + Zcol[1] * z,
    ];
  }
  function unprojectWorldPt(
    x: number,
    y: number,
    z = 0,
  ): readonly [number, number] {
    const [cwx, cwy] = screenToWorld(
      view,
      canvas.clientWidth / 2,
      canvas.clientHeight / 2,
    );
    const dx = x - cwx - Zcol[0] * z;
    const dy = y - cwy - Zcol[1] * z;
    return [cwx + Ainv[0] * dx + Ainv[1] * dy, cwy + Ainv[2] * dx + Ainv[3] * dy];
  }

  /** per-frame display graph: center-projected node positions, same ids */
  let displayNodes = new Map<string, GraphNode>();
  function displayGraph(): Graph {
    // containment overlap is sanctioned — a child sits INSIDE its
    // container's cell — so overlap detection/resolution skips related pairs
    const { related } = containmentOf(graph.nodes);
    if (!rotActive) {
      // even unrotated, RENDERED overlap is not allowed (一格一物): overlaps
      // created by group drags or host position updates pack to flush
      // contact — 辺界消融 then fuses them and snapped-priority merges them.
      // Rendering only; base positions stay untouched.
      let overlapping = false;
      outer: for (let i = 0; i < graph.nodes.length; i++) {
        for (let j = i + 1; j < graph.nodes.length; j++) {
          const a = graph.nodes[i]!;
          const b = graph.nodes[j]!;
          if (related(a.id, b.id)) continue;
          if (
            a.x < b.x + b.w &&
            a.x + a.w > b.x &&
            a.y < b.y + nodeHeight(b) &&
            a.y + nodeHeight(a) > b.y
          ) {
            overlapping = true;
            break outer;
          }
        }
      }
      if (!overlapping) return graph;
      displayNodes = new Map();
      const nodes = graph.nodes.map((n) => {
        const clone = { ...n };
        displayNodes.set(n.id, clone);
        return clone;
      });
      for (let pass = 0; pass < 3; pass++) {
        let moved = false;
        for (const c of nodes) {
          const r = resolveOverlap(
            c,
            c.x,
            c.y,
            nodes.filter((o) => !related(c.id, o.id)),
            { alignSnap: 0, direction: rule.direction },
          );
          if (r.x !== c.x || r.y !== c.y) {
            c.x = r.x;
            c.y = r.y;
            moved = true;
          }
        }
        if (!moved) break;
      }
      return { nodes, edges: graph.edges };
    }
    displayNodes = new Map();
    // whatever the rotation, rendered cards sit on the MAIN visible grid:
    // quantize each projected position to the nearest major grid point
    const mainStep = gridLevels(view.k, rule.minGridPx, rule.radix)[0]!.step;
    const nodes = graph.nodes.map((n) => {
      const h = nodeHeight(n);
      const [qsx, qsy] = nodeSnapStep(mainStep, n);
      const [cx, cy] = projectWorldPt(n.x + n.w / 2, n.y + h / 2, n.z ?? 0);
      const clone = {
        ...n,
        x: snap(cx - n.w / 2, qsx),
        y: snap(cy - h / 2, qsy),
      };
      displayNodes.set(n.id, clone);
      return clone;
    });
    // 一格一物 holds for PROJECTED cards too: quantizing to a coarse grid
    // (or heavy foreshortening) can land neighbors on the same lattice
    // site — push them out to flush contact, exactly like dragged nodes
    // (辺界消融 then fuses the contact; deeper zoom-out rg-merges)
    for (let pass = 0; pass < 3; pass++) {
      let moved = false;
      for (const c of nodes) {
        const r = resolveOverlap(
          c,
          c.x,
          c.y,
          nodes.filter((o) => !related(c.id, o.id)),
          { alignSnap: 0, direction: rule.direction },
        );
        if (r.x !== c.x || r.y !== c.y) {
          c.x = r.x;
          c.y = r.y;
          moved = true;
        }
      }
      if (!moved) break;
    }
    return { nodes, edges: graph.edges };
  }
  let dGraph: Graph = graph;

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
      ctx.strokeStyle = theme.accent;
      ctx.lineWidth = 2;
      for (const id of selection) {
        const n =
          (rotActive ? displayNodes.get(id) : undefined) ??
          graph.nodes.find((m) => m.id === id);
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
      ctx.strokeStyle = theme.accent;
      ctx.fillStyle = withAlpha(theme.accent, 0.08);
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
    // world layers rotate with the viewport; chrome stays upright
    ...(options.layers ?? []),
    (ctx, t) => {
      dGraph = displayGraph();
      // RG monotonicity: zooming OUT carries the previous memberships so a
      // merged block never releases its children mid-outzoom; zooming in
      // (or same k: drags) drops the carry so structure can refine
      const carry =
        lastRg && t.k < lastBuildK - 1e-12
          ? lastRg.pseudo.flatMap((p) =>
              p.members
                .slice(1)
                .map((m, i) => [p.members[i]!.id, m.id] as [string, string]),
            )
          : undefined;
      lastBuildK = t.k;
      lastRg = drawGraph(
        ctx,
        t,
        dGraph,
        rule,
        options.summarize,
        undefined,
        theme,
        carry,
      );
    },
    (ctx, t) => drawSelectionLayer(ctx, t),
    (ctx, t, size) => {
      lastIndicators = lastRg
        ? drawOffscreenIndicators(
            ctx,
            t,
            lastRg,
            size,
            rule,
            undefined,
            theme,
          )
        : [];
    },
    (ctx, t) => drawGhostWire(ctx, t),
    (ctx, _t, size) => {
      lastPanelRects = panelLayout(panels, size);
      drawPanels(ctx, lastPanelRects, theme);
      if (drag?.type === "panelItem" && drag.moved)
        drawPanelDragGhost(ctx, view, drag.item, drag.sx, drag.sy, theme);
    },
  ];
  // grid points are 3-D field arrows: zoom-in rushes the field AT the viewer
  // (⊙ purple, the default), zoom-out sends it away (⊗ gold cross); idle
  // eases back toward ⊙. Updated once per rendered frame in invalidate().
  let zArrow = 1;
  let zLastK: number | null = null;
  const zDirProvider = () => zArrow;
  const fieldTiltProvider = () => {
    const v = fieldVec3();
    return [v.x, v.y] as const;
  };
  const zComposed = () => zArrow * (rotActive ? fieldVec3().z : 1);
  // NOTE: the grid layer is NOT world-rotated — dots keep their positions,
  // only the field direction follows the box rotation
  const gridLayer = createGridDotsLayer(
    rule,
    fieldProvider,
    zComposed,
    fieldTiltProvider,
    theme,
  );

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
    {
      background: wantGpu ? false : themeBg,
      maxDpr: options.maxDpr,
    },
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
    gpu = createWebGPUGridRenderer(
      underlay,
      rule,
      fieldProvider,
      zComposed,
      fieldTiltProvider,
      options.maxDpr,
      theme,
      themeBg,
    );
    gpu.ready.then((ok) => {
      if (destroyed) return;
      if (ok) {
        rendererKind = "webgpu";
      } else {
        // GPU init failed: tear down the underlay and go pure canvas2d
        underlay?.remove();
        underlay = null;
        gpu = null;
        renderer = createCanvas2DRenderer(canvas, [gridLayer, ...contentLayers], {
          maxDpr: options.maxDpr,
          background: themeBg,
        });
        renderer.resize();
      }
      invalidate();
    });
  }

  let view: ViewTransform = options.view ?? { x: 0, y: 0, k: 1 };

  const overlays = createOverlayManager(canvas, {
    // wheel over an overlay must drive rgui pan/zoom (not scroll the page)
    // unless an inner scrollable control consumes it
    forwardWheelTo: canvas,
  });

  let raf = 0;
  let destroyed = false;
  function invalidate() {
    if (raf || destroyed) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      // field-arrow z from zoom velocity (see zDirProvider above)
      if (zLastK === null) zLastK = view.k;
      const dk = Math.log2(view.k / zLastK);
      zLastK = view.k;
      if (dk > 1e-4) zArrow = 1;
      else if (dk < -1e-4) zArrow = -1;
      else if (zArrow < 1) zArrow = Math.min(1, zArrow + 0.05);
      if (rendererKind === "webgpu") gpu?.render(view);
      renderer.render(view);
      overlays.sync(dGraph, lastRg?.nodes ?? null, view, rule);
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

  let lastDebugHtml = "";
  let lastDebugTs = 0;
  function updateDebug() {
    if (!debugEl) return;
    // DOM writes are the expensive part — throttle to 10 Hz and skip
    // unchanged content
    const now = performance.now();
    if (now - lastDebugTs < 100) return;
    lastDebugTs = now;
    const [major, minor] = gridLevels(view.k, rule.minGridPx, rule.radix);
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    const [cwx, cwy] = screenToWorld(view, w / 2, h / 2);
    const [pwx, pwy] = screenToWorld(view, pointer.sx, pointer.sy);
    const rem = parseFloat(
      getComputedStyle(document.documentElement).fontSize,
    );
    const html =
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
    if (html !== lastDebugHtml) {
      lastDebugHtml = html;
      debugEl.innerHTML = html;
    }
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
    const visible = lastRg?.nodes ?? dGraph.nodes;
    // container frames sit BEHIND their children: cards hit first, and
    // among nested frames the innermost (smallest) one wins
    const hasKids = new Set(
      graph.nodes.filter((n) => n.parent).map((n) => n.parent!),
    );
    let frameHit: GraphNode | null = null;
    for (let i = visible.length - 1; i >= 0; i--) {
      const n = visible[i]!;
      const h = nodeHeight(n);
      if (wx < n.x || wx > n.x + n.w || wy < n.y || wy > n.y + h) continue;
      if (!hasKids.has(n.id)) return { type: "node", node: n };
      if (!frameHit || n.w * h < frameHit.w * nodeHeight(frameHit))
        frameHit = n;
    }
    return frameHit ? { type: "node", node: frameHit } : null;
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
    const nodes = lastRg?.nodes ?? dGraph.nodes;
    const layout = computePortLayout(dGraph, nodes, flushSegments(nodes));
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
    const nodes = lastRg?.nodes ?? dGraph.nodes;
    const layout = computePortLayout(dGraph, nodes, flushSegments(nodes));
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

  /** hits return DISPLAY clones under rotation — mutate the BASE node */
  const baseOf = (n: GraphNode): GraphNode =>
    graph.nodes.find((m) => m.id === n.id) ?? n;

  /**
   * PER-AXIS snap steps: each axis snaps to the finer of the viewing main
   * grid and the node's own scale on THAT axis (width layer for x, height
   * layer for y) — a wide-flat node moves coarsely in x, finely in y.
   * Zoomed out, the node's layers cap the coarseness.
   */
  const nodeSnapStep = (
    viewStep: number,
    ...nodes: GraphNode[]
  ): readonly [number, number] => {
    let lx = 0;
    let ly = 0;
    for (const n of nodes) {
      lx = Math.max(lx, sizeLayerStep(n.w, rule.radix));
      ly = Math.max(ly, sizeLayerStep(nodeHeight(n), rule.radix));
    }
    return [
      lx ? Math.min(viewStep, lx) : viewStep,
      ly ? Math.min(viewStep, ly) : viewStep,
    ];
  };

  let drag:
    | {
        type: "node";
        node: GraphNode;
        /** container contents ride along (base nodes, pinned stay put) */
        subtree: GraphNode[];
        /** overlap obstacles: containment relatives are exempt (a child
         * moves INSIDE its frame; a frame moves OVER its children) */
        obstacles: GraphNode[];
        dx: number;
        dy: number;
        downX: number;
        downY: number;
        moved: boolean;
      }
    | {
        type: "pseudo";
        pseudo: PseudoNode;
        wx0: number; // pointer anchor at drag start (display world)
        wy0: number;
        starts: Map<string, { x: number; y: number }>; // base positions
        moved: boolean;
      }
    | {
        type: "group";
        nodes: GraphNode[]; // base nodes of the selection (non-pinned)
        wx: number;
        wy: number;
        moved: boolean;
      }
    | { type: "wire"; from: PortHit; toSx: number; toSy: number }
    | {
        type: "marquee";
        x0: number;
        y0: number;
        x1: number;
        y1: number;
        button: number;
      }
    | {
        type: "resize";
        node: GraphNode;
        moved: boolean;
        /** geometry at grip-down — rescale is a ratio against THIS, not the
         * live node, so a drag out and back lands exactly where it began */
        base: { w: number; h: number; scale: number };
      }
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
    | {
        type: "panel";
        panel: Panel;
        /** pointer offset from the panel's top-left at grab time */
        dx: number;
        dy: number;
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
        ? kindColor(drag.from.port.kind)
        : theme.danger // invalid target
      : kindColor(drag.from.port.kind);
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
    for (const n of lastRg?.nodes ?? dGraph.nodes) {
      const [px, py] = worldToScreenXY(n.x + n.w, n.y + nodeHeight(n));
      if (Math.hypot(px - sx, py - sy) <= 10) return n;
    }
    return null;
  }

  const clamp = (v: number, lo: number, hi: number) =>
    Math.min(hi, Math.max(lo, v));

  /**
   * RESIZE (plain grip drag): the node's world footprint changes, its type
   * does not — more room for the same 11px rows. Grid-snapped corner,
   * minimums respected, stopped at neighbors. Node-size law: a node spans
   * 1..radix grids at SOME layer — exceeding radix grids promotes it to the
   * next layer, snapped to the limit.
   */
  function resizeTo(
    n: GraphNode,
    wx: number,
    wy: number,
    others: GraphNode[],
  ): { w: number; h: number; scale: number } {
    const wantW = Math.max(nodeMinWidth(n), snapSizeRadix(wx - n.x, rule.radix));
    const wantH = Math.max(
      nodeMinHeight(n),
      snapSizeRadix(wy - n.y, rule.radix),
    );
    const { w, h } = clampSize(n, wantW, wantH, others);
    return { w, h, scale: contentScale(n) };
  }

  /**
   * RESCALE (shift + grip drag): the node is magnified — one factor drives
   * w, h and the content scale together, so the ASPECT RATIO is preserved
   * and everything inside (type, ports, padding, the body hook's pixels)
   * grows with the box. The factor is the pointer's projection onto the
   * node's base diagonal: it is exactly 1 when the pointer sits on the
   * corner it grabbed, so the drag starts without a jump.
   *
   * Only the width lands on the lattice: honoring the ratio means the bottom
   * edge follows from the factor rather than snapping on its own.
   */
  function rescaleTo(
    n: GraphNode,
    base: { w: number; h: number; scale: number },
    wx: number,
    wy: number,
    others: GraphNode[],
  ): { w: number; h: number; scale: number } {
    const { w: bw, h: bh } = base;
    const dx = wx - n.x;
    const dy = wy - n.y;
    let f = (dx * bw + dy * bh) / (bw * bw + bh * bh);
    if (!(f > 0)) f = MIN_SCALE / base.scale; // pointer at/behind the origin
    // snap the width to the visible lattice, then re-derive the factor
    f = snapSizeRadix(bw * f, rule.radix) / bw;
    // a scaled node is still a node: keep it in a sane magnification band
    f = clamp(base.scale * f, MIN_SCALE, MAX_SCALE) / base.scale;
    // stop at neighbors — whichever axis hits first governs both
    const { w, h } = clampSize(n, bw * f, bh * f, others);
    f = Math.max(Math.min(w / bw, h / bh), MIN_SCALE / base.scale);
    return { w: bw * f, h: bh * f, scale: base.scale * f };
  }

  /** pin-glyph hit-test (screen ~9px around the glyph) */
  function pinHitAt(sx: number, sy: number): GraphNode | null {
    for (const n of lastRg?.nodes ?? dGraph.nodes) {
      const [wx, wy] = pinPos(n);
      const [px, py] = worldToScreenXY(wx, wy);
      if (Math.hypot(px - sx, py - sy) <= 9) return n;
    }
    return null;
  }

  /** capture-safe: a pointer can be gone by capture time (pen lifted,
   * synthetic events) — losing capture is fine, throwing mid-drag is not */
  const capturePointer = (ev: PointerEvent) => {
    try {
      canvas.setPointerCapture(ev.pointerId);
    } catch {
      /* no active pointer */
    }
  };

  const onPointerDown = (ev: PointerEvent) => {
    if (spaceHeld && input === "figma") return; // space+drag = pan (d3 owns it)
    // chrome hit-tests use RAW screen coords; graph logic uses VIEW coords
    const [vx0, vy0] = toView(ev.offsetX, ev.offsetY);
    // panels are the topmost chrome
    const ph2 = panelHitAt(lastPanelRects, ev.offsetX, ev.offsetY);
    if (ph2) {
      if (ph2.type === "header") {
        // header press starts a panel drag; releasing without moving is
        // the old click → collapse toggle
        drag = {
          type: "panel",
          panel: ph2.rect.panel,
          dx: ev.offsetX - ph2.rect.x,
          dy: ev.offsetY - ph2.rect.y,
          downX: ev.offsetX,
          downY: ev.offsetY,
          moved: false,
        };
        capturePointer(ev);
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
        capturePointer(ev);
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
    const gripHit = gripHitAt(vx0, vy0);
    const gripNode = gripHit && baseOf(gripHit);
    if (gripNode && !gripNode.pinned) {
      drag = {
        type: "resize",
        node: gripNode,
        moved: false,
        base: {
          w: gripNode.w,
          h: nodeHeight(gripNode),
          scale: contentScale(gripNode),
        },
      };
      capturePointer(ev);
      return;
    }
    // pin glyph toggles pinned state
    const pinHit = pinHitAt(vx0, vy0);
    if (pinHit) {
      const pinNode = baseOf(pinHit);
      pinNode.pinned = !pinNode.pinned;
      options.onPinChange?.(pinNode.id, !!pinNode.pinned);
      invalidate();
      return;
    }
    // ports win over node bodies (they overlap the node edge)
    const ph = portAt(vx0, vy0);
    if (ph && (options.onConnect || options.isValidConnection)) {
      drag = { type: "wire", from: ph, toSx: vx0, toSy: vy0 };
      capturePointer(ev);
      return;
    }
    const hit = hitAt(vx0, vy0);
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
        capturePointer(ev);
      }
      return;
    }
    const [wx, wy] = screenToWorld(view, vx0, vy0);
    if (hit.type === "node" && selection.has(hit.node.id) && selection.size > 1) {
      // dragging a member of a multi-selection moves the whole selection —
      // selected containers bring their contents along
      const ids = new Set(selection);
      for (const id of selection)
        for (const d of descendantsOf(graph, id)) ids.add(d.id);
      const members = [...ids]
        .map((id) => graph.nodes.find((m) => m.id === id))
        .filter((m): m is GraphNode => !!m && !m.pinned);
      drag = { type: "group", nodes: members, wx, wy, moved: false };
      capturePointer(ev);
      return;
    }
    if (hit.type === "node") {
      const disp = hit.node; // display-space geometry
      const n = baseOf(disp);
      const { related } = containmentOf(graph.nodes);
      drag = {
        type: "node",
        node: n,
        subtree: descendantsOf(graph, n.id).filter((c) => !c.pinned),
        obstacles: graph.nodes.filter((o) => !related(n.id, o.id)),
        // offsets measured against the DISPLAY rect the user grabbed
        dx: wx - disp.x,
        dy: wy - disp.y,
        downX: ev.offsetX,
        downY: ev.offsetY,
        moved: false,
      };
      // raise to top
      graph.nodes.splice(graph.nodes.indexOf(n), 1);
      graph.nodes.push(n);
    } else {
      // dragging a collapsed group moves all its members together —
      // anchored ABSOLUTELY from the start positions: the block is rebuilt
      // and lattice-snapped every frame, and incremental deltas would
      // compound with that re-snap (block outruns the cursor)
      drag = {
        type: "pseudo",
        pseudo: hit.pseudo,
        wx0: wx,
        wy0: wy,
        starts: new Map(
          hit.pseudo.members.map((m) => {
            const b = baseOf(m);
            return [b.id, { x: b.x, y: b.y }] as const;
          }),
        ),
        moved: false,
      };
    }
    capturePointer(ev);
  };

  const onPointerMove = (ev: PointerEvent) => {
    const [vx0, vy0] = toView(ev.offsetX, ev.offsetY);
    pointer = { sx: vx0, sy: vy0 };
    if (!drag) {
      canvas.style.cursor = gripHitAt(vx0, vy0) ? "nwse-resize" : "grab";
    }
    if (drag) {
      const [wx, wy] = screenToWorld(view, vx0, vy0);
      // rg-ui: whatever the zoom or rotation, everything snaps to the MAIN
      // visible grid — the dots the user can actually see
      const step = gridLevels(view.k, rule.minGridPx, rule.radix)[0]!.step;
      if (drag.type === "resize") {
        const n = drag.node;
        // containment relatives don't clamp: a frame resizes over its
        // children, a child resizes within its frame
        const rel = containmentOf(graph.nodes).related;
        const others = graph.nodes.filter((o) => !rel(n.id, o.id));
        // SHIFT = rescale: the node magnifies (type, ports, body hook and
        // all) instead of reflowing at a fixed type size. Held live, so a
        // drag can switch modes without releasing the grip.
        const next = ev.shiftKey
          ? rescaleTo(n, drag.base, wx, wy, others)
          : resizeTo(n, wx, wy, others);
        if (
          next.w !== n.w ||
          next.h !== nodeHeight(n) ||
          next.scale !== contentScale(n)
        ) {
          n.w = next.w;
          n.h = next.h;
          n.scale = next.scale;
          drag.moved = true;
          options.onNodeResize?.(n.id, {
            w: n.w,
            h: nodeHeight(n),
            scale: next.scale,
          });
        }
      } else if (drag.type === "panelItem") {
        drag.sx = ev.offsetX;
        drag.sy = ev.offsetY;
        if (
          Math.hypot(ev.offsetX - drag.downX, ev.offsetY - drag.downY) >= 4
        )
          drag.moved = true;
      } else if (drag.type === "panel") {
        if (
          Math.hypot(ev.offsetX - drag.downX, ev.offsetY - drag.downY) >= 4
        )
          drag.moved = true;
        if (drag.moved) {
          // dragging makes the anchor an explicit screen position; snap to
          // the viewport margins and flush against the other panels
          const dp = drag.panel;
          const rect = lastPanelRects.find((r) => r.panel === dp);
          const w = rect?.w ?? dp.w ?? PANEL.defaultW;
          const h = rect?.h ?? PANEL.headerH;
          dp.anchor = panelSnap(
            ev.offsetX - drag.dx,
            ev.offsetY - drag.dy,
            w,
            h,
            lastPanelRects.filter((r) => r.panel !== dp),
            { width: canvas.clientWidth, height: canvas.clientHeight },
          );
        }
      } else if (drag.type === "marquee") {
        drag.x1 = ev.offsetX;
        drag.y1 = ev.offsetY;
      } else if (drag.type === "wire") {
        drag.toSx = vx0;
        drag.toSy = vy0;
      } else if (drag.type === "node") {
        if (drag.node.pinned) return; // pinned nodes do not move
        // SNAP ON THE RENDERED PLANE: grid-align the target in display
        // space (what the user sees), then un-project EXACTLY into base
        // space — no second snap there, or the alignment would belong to
        // the rotated plane instead of the visible one
        const h0 = nodeHeight(drag.node);
        const [sx0, sy0] = nodeSnapStep(step, drag.node);
        const [tdx, tdy] = [
          snap(wx - drag.dx, sx0),
          snap(wy - drag.dy, sy0),
        ];
        const [bcx, bcy] = rotActive
          ? unprojectWorldPt(
              tdx + drag.node.w / 2,
              tdy + h0 / 2,
              drag.node.z ?? 0,
            )
          : ([tdx + drag.node.w / 2, tdy + h0 / 2] as const);
        const { x: nx, y: ny } = resolveOverlap(
          drag.node,
          bcx - drag.node.w / 2,
          bcy - h0 / 2,
          drag.obstacles,
          { alignSnap: rule.alignSnapPx / view.k, direction: rule.direction },
        );
        if (nx !== drag.node.x || ny !== drag.node.y) {
          // a container carries its contents: children move by the same delta
          const ddx = nx - drag.node.x;
          const ddy = ny - drag.node.y;
          drag.node.x = nx;
          drag.node.y = ny;
          for (const c of drag.subtree) {
            c.x += ddx;
            c.y += ddy;
            options.onNodeMove?.(c.id, { x: c.x, y: c.y });
          }
          drag.moved = true;
          options.onNodeMove?.(drag.node.id, { x: nx, y: ny });
        }
      } else if (drag.type === "group") {
        const [gsx, gsy] = nodeSnapStep(step, ...drag.nodes);
        const ddx = snap(wx - drag.wx, gsx);
        const ddy = snap(wy - drag.wy, gsy);
        if (ddx || ddy) {
          const bdx = rotActive ? Ainv[0] * ddx + Ainv[1] * ddy : ddx;
          const bdy = rotActive ? Ainv[2] * ddx + Ainv[3] * ddy : ddy;
          for (const n of drag.nodes) {
            n.x += bdx;
            n.y += bdy;
            options.onNodeMove?.(n.id, { x: n.x, y: n.y });
          }
          drag.wx += ddx;
          drag.wy += ddy;
          drag.moved = true;
        }
      } else {
        // a cluster with a pinned member is bolted down
        if (drag.pseudo.members.some((n) => n.pinned)) return;
        const [psx, psy] = nodeSnapStep(step, ...drag.pseudo.members.map(baseOf));
        // TOTAL offset from the drag anchor, quantized once — immune to the
        // per-frame rebuild + lattice re-snap of the block
        const tdx = snap(wx - drag.wx0, psx);
        const tdy = snap(wy - drag.wy0, psy);
        const bdx = rotActive ? Ainv[0] * tdx + Ainv[1] * tdy : tdx;
        const bdy = rotActive ? Ainv[2] * tdx + Ainv[3] * tdy : tdy;
        let changed = false;
        for (const m of drag.pseudo.members) {
          const n = baseOf(m);
          const s0 = drag.starts.get(n.id);
          if (!s0) continue;
          const nx = s0.x + bdx;
          const ny = s0.y + bdy;
          if (nx !== n.x || ny !== n.y) {
            n.x = nx;
            n.y = ny;
            changed = true;
            options.onNodeMove?.(n.id, { x: n.x, y: n.y });
          }
        }
        if (changed) drag.moved = true;
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
          scale: contentScale(drag.node),
        });
      drag = null;
      invalidate();
      return;
    }
    if (drag.type === "panel") {
      if (!drag.moved) {
        // plain header click keeps its old meaning: collapse toggle
        drag.panel.collapsed = !drag.panel.collapsed;
      } else if (typeof drag.panel.anchor === "object") {
        options.onPanelMove?.(drag.panel, drag.panel.anchor);
      }
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
          const [vux, vuy] = toView(ev.offsetX, ev.offsetY);
          const e = edgeAt(vux, vuy);
          if (e) options.onEdgeClick?.(e, { x: ev.offsetX, y: ev.offsetY });
          else if (selection.size) applySelection(new Set());
        }
        drag = null;
        invalidate();
        return;
      }
      if (drag.button === 2) rightDragMoved = true;
      const [va0, vb0] = toView(drag.x0, drag.y0);
      const [va1, vb1] = toView(drag.x1, drag.y1);
      const [wx0, wy0] = screenToWorld(view, Math.min(va0, va1), Math.min(vb0, vb1));
      const [wx1, wy1] = screenToWorld(view, Math.max(va0, va1), Math.max(vb0, vb1));
      const picked = new Set(
        (lastRg?.nodes ?? dGraph.nodes)
          .filter(
            (n) =>
              n.x < wx1 &&
              n.x + n.w > wx0 &&
              n.y < wy1 &&
              n.y + nodeHeight(n) > wy0,
          )
          .map((n) => n.id),
      );
      // merged blocks in the marquee contribute all their members
      for (const p of lastRg?.pseudo ?? []) {
        const r = pseudoRect(p, view.k, rule);
        if (r.x < wx1 && r.x + r.w > wx0 && r.y < wy1 && r.y + r.h > wy0)
          for (const m of p.members) picked.add(m.id);
      }
      applySelection(picked);
      drag = null;
      return;
    }
    if (drag.type === "wire") {
      const [vux, vuy] = toView(ev.offsetX, ev.offsetY);
      const target = portAt(vux, vuy);
      if (target && validConnection(drag.from, target)) {
        const [from, to] =
          drag.from.ref.side === "out"
            ? [drag.from.ref, target.ref]
            : [target.ref, drag.from.ref];
        options.onConnect?.(from, to);
      } else if (!target) {
        // released on empty canvas — let the host offer "create node here"
        const [wx, wy] = screenToWorld(view, vux, vuy);
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
        for (const c of drag.subtree)
          options.onNodeMoveEnd?.(c.id, { x: c.x, y: c.y });
      } else if (
        Math.hypot(ev.offsetX - drag.downX, ev.offsetY - drag.downY) < 4
      ) {
        if (ev.shiftKey || ev.metaKey || ev.ctrlKey) {
          // multi-select: toggle membership instead of replacing
          const next = new Set(selection);
          if (next.has(drag.node.id)) next.delete(drag.node.id);
          else next.add(drag.node.id);
          applySelection(next);
        } else {
          applySelection(new Set([drag.node.id]));
        }
        options.onNodeClick?.(drag.node.id, { x: ev.offsetX, y: ev.offsetY });
      }
    } else if (drag.type === "group") {
      if (drag.moved)
        for (const n of drag.nodes)
          options.onNodeMoveEnd?.(n.id, { x: n.x, y: n.y });
    } else if (drag.type === "pseudo") {
      if (drag.moved) {
        // pseudo drags report every member's final BASE position
        for (const m of drag.pseudo.members) {
          const n = baseOf(m);
          options.onNodeMoveEnd?.(n.id, { x: n.x, y: n.y });
        }
      } else {
        // CLICK on a merged block: selecting at this level selects all its
        // members — zoom back in and every member is selected. Shift
        // toggles the whole group in/out.
        const ids = drag.pseudo.members.map((m) => m.id);
        if (ev.shiftKey || ev.metaKey || ev.ctrlKey) {
          const next = new Set(selection);
          const allIn = ids.every((id) => next.has(id));
          for (const id of ids) allIn ? next.delete(id) : next.add(id);
          applySelection(next);
        } else {
          applySelection(new Set(ids));
        }
      }
    }
    drag = null;
    invalidate();
  };

  const onDblClick = (ev: MouseEvent) => {
    // double-click selects the whole SNAPPED stack the node belongs to
    const [vx, vy] = toView(ev.offsetX, ev.offsetY);
    const hit = hitAt(vx, vy);
    if (!hit || hit.type !== "node") return;
    const nodes = lastRg?.nodes ?? dGraph.nodes;
    const comp = flushComponents(nodes, flushSegments(nodes));
    const root = comp.get(hit.node.id);
    const ids = nodes
      .filter((n) => comp.get(n.id) === root)
      .map((n) => n.id);
    applySelection(new Set(ids.length ? ids : [hit.node.id]));
  };

  const onContextMenu = (ev: MouseEvent) => {
    if (rightDragMoved) {
      // a right-button box select just ended — not a menu
      rightDragMoved = false;
      ev.preventDefault();
      return;
    }
    const [vcx, vcy] = toView(ev.offsetX, ev.offsetY);
    const hit = hitAt(vcx, vcy);
    if (hit?.type === "node" && options.onNodeContextMenu) {
      ev.preventDefault();
      options.onNodeContextMenu(hit.node.id, {
        x: ev.offsetX,
        y: ev.offsetY,
      });
      return;
    }
    if (!hit) {
      const e = edgeAt(vcx, vcy);
      if (e && options.onEdgeContextMenu) {
        ev.preventDefault();
        options.onEdgeContextMenu(e, { x: ev.offsetX, y: ev.offsetY });
        return;
      }
      if (!e && options.onCanvasContextMenu) {
        ev.preventDefault();
        const [wx, wy] = screenToWorld(view, vcx, vcy);
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
  canvas.addEventListener("dblclick", onDblClick);

  // --- pan / zoom (figma-style input by default) --------------------------

  const input = options.input ?? "figma";
  let spaceHeld = false;

  // --- keyboard navigation (CapsLockX accel model) ------------------------
  // WASD pans, R/F zoom, N/P (Tab/Shift+Tab) cycle node focus, ? shows help.
  // The physics are the CapsLockX cursor-accel model (see core/accModel.ts):
  // acceleration grows with how long a key is held, so a tap nudges and a
  // hold ramps up — identical feel to moving the mouse in CapsLockX.
  const kbEnabled = options.keyboard ?? true;
  const panRate = options.keyboardSpeed?.pan ?? 1600;
  const zoomRate = options.keyboardSpeed?.zoom ?? 1600;
  // zoom displacement (units) → log-scale exponent per frame; tuned so a short
  // R/F tap zooms a readable step while a hold accelerates smoothly.
  const ZOOM_SENS = 0.0011;
  const panModel = new AccModel2D(panRate);
  const zoomModel = new AccModel2D(zoomRate);
  let pointerInside = false;
  let focusIndex = -1;

  let navRaf = 0;
  const navTick = () => {
    navRaf = 0;
    const now = performance.now();
    const p = panModel.tick(now);
    const z = zoomModel.tick(now);
    const W = canvas.clientWidth;
    const H = canvas.clientHeight;
    let nx = view.x;
    let ny = view.y;
    let nk = view.k;
    // pan is a screen-space translation (+right/+down key ⇒ camera moves that
    // way, i.e. the scene translates the opposite way on screen)
    nx -= p.dx;
    ny -= p.dy;
    if (z.dy) {
      // R = pressUp ⇒ dy<0 ⇒ zoom in; keep the viewport-center world point put
      const nk2 = Math.min(1e6, Math.max(1e-6, nk * Math.exp(-z.dy * ZOOM_SENS)));
      const [wx, wy] = screenToWorld({ x: nx, y: ny, k: nk }, W / 2, H / 2);
      nx = W / 2 - wx * nk2;
      ny = H / 2 - wy * nk2;
      nk = nk2;
    }
    if (nx !== view.x || ny !== view.y || nk !== view.k) {
      sel.call(
        zoomBehavior.transform,
        zoomIdentity.translate(nx, ny).scale(nk),
      );
    }
    if (p.active || z.active) navRaf = requestAnimationFrame(navTick);
  };
  const navKick = () => {
    if (!navRaf) navRaf = requestAnimationFrame(navTick);
  };

  /** cycle single-node focus (dir +1 = next, -1 = prev) and pan it center. */
  const cycleFocus = (dir: number) => {
    const ns = graph.nodes;
    if (!ns.length) return;
    if (focusIndex < 0 || focusIndex >= ns.length)
      focusIndex = dir > 0 ? 0 : ns.length - 1;
    else focusIndex = (focusIndex + dir + ns.length) % ns.length;
    const n = ns[focusIndex]!;
    applySelection(new Set([n.id]));
    panTo(n.x + n.w / 2, n.y + nodeHeight(n) / 2);
  };

  // --- shortcuts panel (?) ------------------------------------------------
  let helpEl: HTMLDivElement | null = null;
  const toggleHelp = () => {
    if (helpEl) {
      helpEl.remove();
      helpEl = null;
      return;
    }
    const rows: [string, string][] = [
      ["W A S D", "Pan"],
      ["R / F", "Zoom in / out"],
      ["N / P", "Focus next / prev node"],
      ["Tab / ⇧Tab", "Focus next / prev node"],
      ["Space + drag", "Pan"],
      ["Scroll / pinch", "Pan / zoom"],
      ["Drag corner", "Resize node"],
      ["⇧ + drag corner", "Rescale node (magnify, keeps ratio)"],
      ["?", "Toggle this panel"],
    ];
    helpEl = document.createElement("div");
    helpEl.className = "rgui-shortcuts";
    Object.assign(helpEl.style, {
      position: "fixed",
      inset: "0",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      background: "rgba(0,0,0,0.45)",
      zIndex: "2147483000",
      font: "13px/1.5 ui-sans-serif, system-ui, sans-serif",
    } as CSSStyleDeclaration);
    const card = document.createElement("div");
    Object.assign(card.style, {
      background: "#1b1e24",
      color: "#e8eaed",
      border: "1px solid #333842",
      borderRadius: "12px",
      padding: "20px 24px",
      minWidth: "300px",
      boxShadow: "0 12px 40px rgba(0,0,0,0.5)",
    } as CSSStyleDeclaration);
    card.innerHTML =
      `<div style="font-weight:600;font-size:15px;margin-bottom:14px">` +
      `Keyboard shortcuts</div>` +
      `<table style="border-collapse:collapse;width:100%">` +
      rows
        .map(
          ([keys, act]) =>
            `<tr><td style="padding:4px 16px 4px 0;white-space:nowrap">` +
            keys
              .split(" ")
              .map(
                (k) =>
                  `<kbd style="display:inline-block;padding:2px 7px;margin:0 2px 0 0;` +
                  `background:#2a2e37;border:1px solid #3c424e;border-bottom-width:2px;` +
                  `border-radius:5px;font:600 12px ui-monospace,monospace">${k}</kbd>`,
              )
              .join("") +
            `</td><td style="padding:4px 0;color:#aab0bd">${act}</td></tr>`,
        )
        .join("") +
      `</table>` +
      `<div style="margin-top:14px;color:#7b8291;font-size:12px">` +
      `Esc or ? to close</div>`;
    helpEl.appendChild(card);
    helpEl.addEventListener("pointerdown", (e) => {
      if (e.target === helpEl) toggleHelp();
    });
    document.body.appendChild(helpEl);
  };

  const typingInField = (ev: KeyboardEvent) => {
    const t = ev.target as HTMLElement | null;
    return !!(
      t &&
      (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable)
    );
  };

  const onKeyDown = (ev: KeyboardEvent) => {
    if (ev.code === "Space" && !ev.repeat) {
      if (typingInField(ev)) return;
      spaceHeld = true;
      canvas.style.cursor = "grab";
      return;
    }
    if (!kbEnabled) return;
    // ? closes the help panel from anywhere; Esc closes it too
    if (helpEl && ev.key === "Escape") {
      ev.preventDefault();
      toggleHelp();
      return;
    }
    if (typingInField(ev)) return;
    if (ev.ctrlKey || ev.metaKey || ev.altKey) return; // leave OS/app chords
    if (ev.key === "?") {
      ev.preventDefault();
      toggleHelp();
      return;
    }
    // focus cycling works whenever the canvas is engaged
    const engaged = pointerInside || document.activeElement === canvas;
    if (engaged && (ev.key === "n" || (ev.key === "Tab" && !ev.shiftKey))) {
      ev.preventDefault();
      cycleFocus(1);
      return;
    }
    if (engaged && (ev.key === "p" || (ev.key === "Tab" && ev.shiftKey))) {
      ev.preventDefault();
      cycleFocus(-1);
      return;
    }
    if (!engaged) return;
    const now = performance.now();
    switch (ev.key.toLowerCase()) {
      case "a":
        panModel.pressLeft(now);
        break;
      case "d":
        panModel.pressRight(now);
        break;
      case "w":
        panModel.pressUp(now);
        break;
      case "s":
        panModel.pressDown(now);
        break;
      case "r":
        zoomModel.pressUp(now);
        break;
      case "f":
        zoomModel.pressDown(now);
        break;
      default:
        return;
    }
    ev.preventDefault();
    navKick();
  };
  const onKeyUp = (ev: KeyboardEvent) => {
    if (ev.code === "Space") spaceHeld = false;
    if (!kbEnabled) return;
    switch (ev.key.toLowerCase()) {
      case "a":
        panModel.releaseLeft();
        break;
      case "d":
        panModel.releaseRight();
        break;
      case "w":
        panModel.releaseUp();
        break;
      case "s":
        panModel.releaseDown();
        break;
      case "r":
        zoomModel.releaseUp();
        break;
      case "f":
        zoomModel.releaseDown();
        break;
    }
  };
  const onPointerEnter = () => {
    pointerInside = true;
  };
  const onPointerLeave = () => {
    pointerInside = false;
    // releasing focus stops runaway pan if a key is still logically "down"
    panModel.stop();
    zoomModel.stop();
  };
  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", onKeyUp);
  if (kbEnabled) {
    canvas.addEventListener("pointerenter", onPointerEnter);
    canvas.addEventListener("pointerleave", onPointerLeave);
  }

  /**
   * figma wheel: ctrl/pinch + discrete mouse wheel = zoom; 2-finger = pan.
   * STREAM STICKINESS: a fast touchpad flick emits large integer deltas
   * that look like mouse-wheel ticks — so within a rapid burst, the first
   * classification wins (ctrl/pinch always zooms).
   */
  let wheelStreak: { ts: number; zoom: boolean } = { ts: 0, zoom: false };
  const onWheel = (ev: WheelEvent) => {
    if (input !== "figma") return; // classic: d3 handles wheel
    ev.preventDefault();
    // client-rect math, not offsetX: forwarded clones from the overlay
    // layer must zoom at the true cursor point (offsetX would be relative
    // to the overlay element — and synthetic events mangle it by dpr)
    const rect = canvas.getBoundingClientRect();
    const [ox, oy] = toView(ev.clientX - rect.left, ev.clientY - rect.top);
    const now = performance.now();
    const inStreak = now - wheelStreak.ts < 160;
    const isZoom =
      ev.ctrlKey || // pinch gesture or ctrl+wheel — always zooms
      (inStreak
        ? wheelStreak.zoom // mid-burst: keep the burst's classification
        : ev.deltaMode !== 0 || // line/page mode = real mouse wheel
          (ev.deltaX === 0 &&
            Number.isInteger(ev.deltaY) &&
            Math.abs(ev.deltaY) >= 50)); // isolated discrete tick
    if (ev.ctrlKey) wheelStreak.ts = 0; // pinch resets the burst
    else wheelStreak = { ts: now, zoom: isZoom };
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
      const [wx, wy] = screenToWorld(view, ox, oy);
      sel.call(
        zoomBehavior.transform,
        zoomIdentity.translate(ox - wx * k, oy - wy * k).scale(k),
      );
    } else {
      // touchpad two-finger scroll pans both axes (view is always 2-D)
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
      const [fvx, fvy] = toView(me.offsetX, me.offsetY);
      if (gripHitAt(fvx, fvy)) return false; // resize grip
      if (
        (options.onConnect || options.isValidConnection) &&
        portAt(fvx, fvy)
      )
        return false; // wire drag wins
      return !hitAt(fvx, fvy);
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
    get theme() {
      return theme;
    },
    setTheme(input: RgThemeInput) {
      // one mutable theme object: layers close over it — assign + redraw
      Object.assign(theme, resolveTheme(input));
      invalidate();
    },
    get rotation() {
      return rot3.roll;
    },
    get rotation3() {
      return { ...rot3 };
    },
    setRotation(rad: number, opts?: { animate?: boolean }) {
      this.setRotation3({ roll: rad }, opts);
    },
    setRotation3(
      target: { yaw?: number; pitch?: number; roll?: number },
      opts?: { animate?: boolean },
    ) {
      // full range allowed: near edge-on the LOD collapses the graph (the
      // det guard keeps the inverse finite); past 90° you see the plane's
      // mirrored back — physically honest for a sheet in space
      const to = {
        yaw: target.yaw ?? rot3.yaw,
        pitch: target.pitch ?? rot3.pitch,
        roll: target.roll ?? rot3.roll,
      };
      if (opts?.animate === false) {
        Object.assign(rot3, to);
        updateRotation();
        invalidate();
        return;
      }
      const from = { ...rot3 };
      const t0 = performance.now();
      const dur = 180;
      const step = (now: number) => {
        const u = Math.min(1, (now - t0) / dur);
        const e = u < 0.5 ? 2 * u * u : 1 - (-2 * u + 2) ** 2 / 2;
        rot3.yaw = from.yaw + (to.yaw - from.yaw) * e;
        rot3.pitch = from.pitch + (to.pitch - from.pitch) * e;
        rot3.roll = from.roll + (to.roll - from.roll) * e;
        updateRotation();
        invalidate();
        if (u < 1) requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
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
    snapGraph(opts?: { silent?: boolean }) {
      const step = gridLevels(view.k, rule.minGridPx, rule.radix)[0]!.step;
      for (const n of graph.nodes) {
        const [gsx, gsy] = nodeSnapStep(step, n);
        const nx = snap(n.x, gsx);
        const ny = snap(n.y, gsy);
        if (nx !== n.x || ny !== n.y) {
          n.x = nx;
          n.y = ny;
          if (!opts?.silent) options.onNodeMoveEnd?.(n.id, { x: nx, y: ny });
        }
        // size law: 1..radix grids at some layer, never below minimums
        const minH = nodeMinHeight(n);
        const nw = Math.max(nodeMinWidth(n), snapSizeRadix(n.w, rule.radix));
        const nh = Math.max(minH, snapSizeRadix(nodeHeight(n), rule.radix));
        if (nw !== n.w || nh !== nodeHeight(n)) {
          n.w = nw;
          n.h = nh;
          // snapping is a RESIZE: the footprint lands on the lattice, the
          // node's own magnification is left alone
          if (!opts?.silent)
            options.onNodeResizeEnd?.(n.id, {
              w: nw,
              h: nodeHeight(n),
              scale: contentScale(n),
            });
        }
      }
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
      const rel = containmentOf(graph.nodes).related;
      const { w, h } = clampSize(
        n,
        Math.max(nodeMinWidth(n), size.w ?? n.w),
        Math.max(nodeMinHeight(n), size.h ?? nodeHeight(n)),
        graph.nodes.filter((o) => !rel(n.id, o.id)),
      );
      n.w = w;
      n.h = h;
      invalidate();
    },
    rescaleNode(nodeId: string, scale: number) {
      const n = graph.nodes.find((m) => m.id === nodeId);
      if (!n) return;
      const next = clamp(scale, MIN_SCALE, MAX_SCALE);
      const f = next / contentScale(n);
      n.w *= f;
      n.h = nodeHeight(n) * f;
      n.scale = next;
      invalidate();
    },
    portScreenPos(nodeId: string, portId: string, side: "in" | "out") {
      const nodes = lastRg?.nodes ?? dGraph.nodes;
      const layout = computePortLayout(dGraph, nodes, flushSegments(nodes));
      const pl = layout.get(`${nodeId}/${side}/${portId}`);
      if (!pl) return null;
      const [x, y] = fromView(...worldToScreenXY(pl.x, pl.y));
      return { x, y, edge: pl.edge, hidden: pl.hidden };
    },
    edgeMidScreen(edge: {
      from: { node: string; port: string };
      to: { node: string; port: string };
    }) {
      const nodes = lastRg?.nodes ?? dGraph.nodes;
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
      const [mx, my] = fromView(
        0.125 * (x0 + x1) + 0.375 * (cx0 + cx1),
        0.5 * (y0 + y1),
      );
      return { x: mx, y: my };
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
      canvas.removeEventListener("pointerenter", onPointerEnter);
      canvas.removeEventListener("pointerleave", onPointerLeave);
      canvas.removeEventListener("wheel", onWheel);
      if (navRaf) cancelAnimationFrame(navRaf);
      helpEl?.remove();
      if (raf) cancelAnimationFrame(raf);
      ro.disconnect();
      sel.on(".zoom", null);
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointerup", onPointerUp);
      canvas.removeEventListener("contextmenu", onContextMenu);
      canvas.removeEventListener("dblclick", onDblClick);
    },
  };
}
