/**
 * rgui HTML overlays — real DOM controls glued to nodes.
 *
 * Canvas cannot host interactive form controls, so rgui owns a positioned
 * DOM layer above the canvas and keeps each registered element glued to its
 * node's screen rect every frame (drag included). Size is screen-fixed
 * (overlays do not scale with zoom); only position follows.
 *
 * Visibility reuses the native readability rule: an overlay hides (without
 * being destroyed) whenever its node is collapsed into a pseudo-node,
 * fully off-screen, or too small to read — so collapsed stacks show only
 * boundary ports + the pseudo summary, never per-node config.
 */
import { nodeHeight, NODE_ROW_H, type Graph, type GraphNode } from "../core/graph.js";
import type { ViewTransform } from "../core/grid.js";
import type { RgRule } from "../core/rule.js";

export interface NodeHtmlOverlay {
  el: HTMLElement;
  /** where to glue relative to the node rect (default "right") */
  anchor?: "right" | "below" | "over";
  /**
   * offset from the anchor point — screen px in "fixed" mode, WORLD units
   * in "zoom" mode (it belongs to the node's local layout, so it scales)
   */
  offset?: { x: number; y: number };
  /**
   * "fixed" (default): screen-constant size, position glued to the node.
   * "zoom": scales with view.k like part of the node (lay out for k=1).
   * "fit": rgui measures the element's natural size and applies
   *   scale = min(1, node screen area / natural size) — the control always
   *   fits the node's on-screen area, whatever the node type's size.
   * In zoom/fit modes, when the applied scale drops below `minScale` the
   * overlay hides and the native/summarized content takes over.
   */
  scale?: "fixed" | "zoom" | "fit";
  /**
   * zoom/fit modes: hide when the applied scale drops below this
   * (default 0.75) — an unreadable control yields to the summary.
   * Hide always wins over scaling.
   */
  minScale?: number;
  /**
   * pointer-events mode (default true). When true, only actual CONTROLS
   * inside the element receive pointer events (inputs, selects, buttons,
   * links, [contenteditable], [data-rgui-interactive]) — the background is
   * click-through so node drag / canvas pan keep working underneath.
   * Mark custom widgets with data-rgui-interactive.
   */
  interactive?: boolean;
  /** called when the overlay is unmounted (replaced, node gone, destroy) */
  destroy?: () => void;
}

export interface OverlayManager {
  /** glue/refresh all overlays for the current frame */
  sync(
    graph: Graph,
    visibleNodes: GraphNode[] | null,
    view: ViewTransform,
    rule: RgRule,
  ): void;
  destroy(): void;
}

export function createOverlayManager(
  canvas: HTMLCanvasElement,
  opts?: {
    /**
     * re-dispatch wheel events here (usually the rgui canvas) so pan/zoom
     * keeps working over overlays instead of scrolling the page. A wheel is
     * NOT forwarded when an inner scrollable element can still consume it.
     */
    forwardWheelTo?: HTMLElement;
    /** map view-space anchor points to raw screen (viewport rotation) */
    transformPoint?: (x: number, y: number) => readonly [number, number];
  },
): OverlayManager {
  let layer: HTMLDivElement | null = null;
  const mounted = new Map<
    string,
    { ov: NodeHtmlOverlay; wrap: HTMLDivElement; mo?: MutationObserver }
  >();

  const CONTROLS =
    'input,select,textarea,button,a,label,[contenteditable="true"],[data-rgui-interactive]';

  /**
   * click-through background: the element ignores pointers, its controls
   * receive them — so pressing overlay whitespace drags the node beneath
   */
  function applyControlPassthrough(el: HTMLElement) {
    el.style.pointerEvents = "none";
    if (el.matches?.(CONTROLS)) el.style.pointerEvents = "auto";
    for (const c of el.querySelectorAll<HTMLElement>(CONTROLS))
      c.style.pointerEvents = "auto";
  }

  /** can any scrollable between target and the layer consume this wheel? */
  function scrollableConsumes(ev: WheelEvent): boolean {
    let el = ev.target as HTMLElement | null;
    while (el && el !== layer) {
      const style = getComputedStyle(el);
      const oy = style.overflowY;
      if (
        (oy === "auto" || oy === "scroll") &&
        el.scrollHeight > el.clientHeight + 1
      ) {
        const down = ev.deltaY > 0;
        const canScroll = down
          ? el.scrollTop + el.clientHeight < el.scrollHeight - 1
          : el.scrollTop > 0;
        if (canScroll) return true;
      }
      el = el.parentElement;
    }
    return false;
  }

  const onLayerWheel = (ev: WheelEvent) => {
    if (!opts?.forwardWheelTo) return;
    if (scrollableConsumes(ev)) return; // let the control scroll natively
    ev.preventDefault(); // never scroll/zoom the page
    ev.stopPropagation();
    opts.forwardWheelTo.dispatchEvent(new WheelEvent("wheel", ev));
  };

  function ensureLayer(): HTMLDivElement | null {
    if (layer) return layer;
    const parent = canvas.parentElement;
    if (!parent) return null;
    if (getComputedStyle(parent).position === "static")
      parent.style.position = "relative";
    layer = document.createElement("div");
    layer.className = "rgui-overlay-layer";
    // viewport clip by default; wrapper is a pass-through. overscroll
    // containment stops scroll chaining out of overlay controls.
    layer.style.cssText =
      "position:absolute;inset:0;overflow:hidden;pointer-events:none;overscroll-behavior:contain;";
    layer.addEventListener("wheel", onLayerWheel, { passive: false });
    parent.appendChild(layer);
    return layer;
  }

  function unmount(id: string) {
    const m = mounted.get(id);
    if (!m) return;
    m.mo?.disconnect();
    m.wrap.remove();
    try {
      m.ov.destroy?.();
    } catch (err) {
      console.error("[rgui] overlay destroy failed:", err);
    }
    mounted.delete(id);
  }

  function sync(
    graph: Graph,
    visibleNodes: GraphNode[] | null,
    view: ViewTransform,
    rule: RgRule,
  ) {
    const want = new Map(
      graph.nodes.filter((n) => n.overlay).map((n) => [n.id, n]),
    );
    // unmount overlays whose node vanished or whose element was replaced
    for (const [id, m] of [...mounted]) {
      const n = want.get(id);
      if (!n || n.overlay!.el !== m.ov.el) unmount(id);
    }
    if (!want.size) return;
    if (!ensureLayer()) return;

    const visible = new Set((visibleNodes ?? graph.nodes).map((n) => n.id));
    const W = canvas.clientWidth;
    const H = canvas.clientHeight;
    let z = 0;
    for (const [id, n] of want) {
      let m = mounted.get(id);
      if (!m) {
        const ov = n.overlay!;
        const wrap = document.createElement("div");
        wrap.dataset["nodeId"] = id;
        wrap.style.cssText =
          "position:absolute;left:0;top:0;pointer-events:none;will-change:transform;";
        wrap.appendChild(ov.el);
        layer!.appendChild(wrap);
        m = { ov, wrap };
        if (ov.interactive === false) {
          ov.el.style.pointerEvents = "none";
        } else {
          applyControlPassthrough(ov.el);
          // hosts re-render controls dynamically (e.g. React) — keep the
          // control passthrough fresh
          m.mo = new MutationObserver(() => applyControlPassthrough(ov.el));
          m.mo.observe(ov.el, { childList: true, subtree: true });
        }
        mounted.set(id, m);
      }
      const k = view.k;
      const h = nodeHeight(n);
      const x0 = n.x * k + view.x;
      const y0 = n.y * k + view.y;
      const x1 = (n.x + n.w) * k + view.x;
      const y1 = (n.y + h) * k + view.y;
      // applied scale: zoom follows view.k; fit measures the element and
      // fills the node's screen area (never upscaling past natural size)
      const el = m.ov.el;
      let applied = 1;
      if (m.ov.scale === "zoom") {
        applied = k;
      } else if (m.ov.scale === "fit") {
        const nw = el.offsetWidth || 1;
        const nh = el.offsetHeight || 1;
        const anchor0 = m.ov.anchor ?? "right";
        applied =
          anchor0 === "over"
            ? Math.min(1, (x1 - x0) / nw, (y1 - y0) / nh)
            : anchor0 === "right"
              ? Math.min(1, (y1 - y0) / nh)
              : Math.min(1, (x1 - x0) / nw);
      }
      // readability gate: scaled controls hide below their readable scale
      // (hide wins over scaling → the summarized content takes over);
      // fixed overlays follow the node's field readability
      const readable =
        m.ov.scale === "zoom" || m.ov.scale === "fit"
          ? applied >= (m.ov.minScale ?? 0.75)
          : NODE_ROW_H * k >= rule.fieldMinPx;
      const offscreen = x1 < 0 || y1 < 0 || x0 > W || y0 > H;
      const show = visible.has(id) && readable && !offscreen;
      m.wrap.style.display = show ? "" : "none";
      if (!show) continue;
      const anchor = m.ov.anchor ?? "right";
      const d =
        m.ov.offset ??
        (anchor === "right"
          ? { x: 8, y: 0 }
          : anchor === "below"
            ? { x: 0, y: 8 }
            : { x: 0, y: 0 });
      const scaled = m.ov.scale === "zoom" || m.ov.scale === "fit";
      // scaled modes: offsets belong to the node's local layout, so they
      // scale with the element; anchored at its top-left (origin 0 0)
      const dx = scaled ? d.x * applied : d.x;
      const dy = scaled ? d.y * applied : d.y;
      let tx = anchor === "right" ? x1 + dx : x0 + dx;
      let ty = anchor === "below" ? y1 + dy : y0 + dy;
      if (opts?.transformPoint) [tx, ty] = opts.transformPoint(tx, ty);
      m.wrap.style.transformOrigin = "0 0";
      m.wrap.style.transform = scaled
        ? `translate(${tx}px, ${ty}px) scale(${applied})`
        : `translate(${tx}px, ${ty}px)`;
      m.wrap.style.zIndex = String(z++);
    }
  }

  return {
    sync,
    destroy() {
      for (const id of [...mounted.keys()]) unmount(id);
      layer?.removeEventListener("wheel", onLayerWheel);
      layer?.remove();
      layer = null;
    },
  };
}
